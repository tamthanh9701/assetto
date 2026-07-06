import { ImageAIProvider, SceneInput, GenResult, ExtractInput, LayerResult, BgInput, PngResult } from "../types";

const IMAGE_GEN_MODEL = "gemini-2.5-flash-image";
const SEGMENTATION_MODEL = "gemini-2.5-flash";

const ALLOWED_TYPES = new Set([
  "BACKGROUND",
  "PANEL",
  "BUTTON",
  "ICON",
  "BAR",
  "BADGE",
  "CHARACTER",
  "SPRITE",
  "CUSTOM",
]);

interface SegmentationBox {
  box_2d?: [number, number, number, number];
  mask?: string;
  label?: string;
  type?: string;
  name?: string;
  confidence?: number;
}

interface NormalizedComponent {
  name: string;
  type: string;
  imageUrl: string;
  box2d: [number, number, number, number];
  confidence?: number;
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
  baseDelay = 1000
): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    const delay = baseDelay * Math.pow(2, attempt);
    console.warn(`[Gemini] 429 rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
    await new Promise((r) => setTimeout(r, delay));
  }
  return fetch(url, options);
}

function normalizeLabel(value?: string): string {
  const label = (value || "CUSTOM").toUpperCase().replace(/[^A-Z_]/g, "_");
  if (label === "ILLUSTRATION") return "CHARACTER";
  if (ALLOWED_TYPES.has(label)) return label;
  return "CUSTOM";
}

function normalizeBox(box: unknown): [number, number, number, number] | null {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const values = box.map((v) => Number(v));
  if (values.some((v) => !Number.isFinite(v))) return null;

  let [y1, x1, y2, x2] = values;
  y1 = Math.max(0, Math.min(1000, y1));
  x1 = Math.max(0, Math.min(1000, x1));
  y2 = Math.max(0, Math.min(1000, y2));
  x2 = Math.max(0, Math.min(1000, x2));

  if (y2 < y1) [y1, y2] = [y2, y1];
  if (x2 < x1) [x1, x2] = [x2, x1];

  if (y2 - y1 < 6 || x2 - x1 < 6) return null;
  return [y1, x1, y2, x2];
}

function computeIoU(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ax1 = a[1], ay1 = a[0], ax2 = a[3], ay2 = a[2];
  const bx1 = b[1], by1 = b[0], bx2 = b[3], by2 = b[2];
  const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const areaA = (ax2 - ax1) * (ay2 - ay1);
  const areaB = (bx2 - bx1) * (by2 - by1);
  return inter / Math.max(1, areaA + areaB - inter);
}

function parseJsonPayload(rawText: string): any {
  const cleaned = rawText.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const objectMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objectMatch) return JSON.parse(objectMatch[0]);
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) return JSON.parse(arrayMatch[0]);
    throw new Error(`No JSON payload found in Gemini response: ${rawText.slice(0, 200)}`);
  }
}

function coerceElements(parsed: any): SegmentationBox[] {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.elements)) return parsed.elements;
  if (Array.isArray(parsed?.components)) return parsed.components;
  if (parsed?.box_2d) return [parsed];
  return [];
}

function nms(components: NormalizedComponent[]): NormalizedComponent[] {
  const sorted = [...components].sort((a, b) => (b.confidence ?? 0.5) - (a.confidence ?? 0.5));
  const kept: NormalizedComponent[] = [];

  for (const candidate of sorted) {
    const duplicate = kept.some((existing) => {
      const iou = computeIoU(candidate.box2d, existing.box2d);
      return iou > 0.65 || (candidate.type === existing.type && iou > 0.42);
    });
    if (!duplicate) kept.push(candidate);
  }

  return kept
    .sort((a, b) => {
      const rowDiff = a.box2d[0] - b.box2d[0];
      return Math.abs(rowDiff) < 35 ? a.box2d[1] - b.box2d[1] : rowDiff;
    })
    .slice(0, 60);
}

export class GeminiProvider implements ImageAIProvider {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || "";
  }

  async generateScene(input: SceneInput): Promise<GenResult> {
    const startTime = Date.now();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_GEN_MODEL}:generateContent?key=${this.apiKey}`;

    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `Generate a game UI scene: ${input.prompt}. Aspect ratio: ${input.ratio || "16:9"}. Clean game UI design with clear reusable sections for background, panels, buttons, icons, bars, and badges. Avoid merging important UI controls into the background.`,
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["Text", "Image"],
          ...(input.seed ? { seed: input.seed } : {}),
          imageConfig: {
            aspectRatio: input.ratio || "9:16",
          },
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    const candidate = data?.candidates?.[0];
    if (!candidate) {
      const reason = data?.promptFeedback?.blockReason || "unknown";
      throw new Error(`Gemini blocked. Reason: ${reason}. Full: ${JSON.stringify(data)}`);
    }

    const part = candidate?.content?.parts?.find((p: any) => p.inlineData);
    const imageUrl = part?.inlineData?.data
      ? `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
      : "";

    if (!imageUrl) {
      const textPart = candidate?.content?.parts?.find((p: any) => p.text);
      throw new Error(`Gemini returned no image. Text: ${textPart?.text || "none"}`);
    }

    return { imageUrl, seed: input.seed, duration: Date.now() - startTime };
  }

  async extractLayers(input: ExtractInput): Promise<LayerResult> {
    const imgBuffer = await this.fetchImageForSegmentation(input.imageUrl);
    const sharp = await import("sharp");
    const imgMeta = await sharp.default(imgBuffer).metadata();
    const W = imgMeta.width || 1024;
    const H = imgMeta.height || 576;
    const base64Image = imgBuffer.toString("base64");

    const globalPrompt = `You are extracting reusable game UI assets from a generated scene.
Return ONLY valid JSON in this exact shape:
{"elements":[{"name":"Main Panel","type":"PANEL","box_2d":[y1,x1,y2,x2],"confidence":0.9}]}
Rules:
- Coordinates are normalized 0-1000 relative to the FULL image.
- type must be one of BACKGROUND, PANEL, BUTTON, ICON, BAR, BADGE, CHARACTER, SPRITE, CUSTOM.
- Detect whole reusable UI components, not text-only labels or tiny decorative pixels.
- Include separate buttons, icons, bars, badges, panels, character/illustration art, and major sprites.
- Prefer tight boxes around the visible component. Maximum 50 elements.`;

    let components = await this.detectComponents(base64Image, globalPrompt, W, H);

    if (components.length < 3) {
      console.warn(`[Gemini extract] global detection returned ${components.length}; running zone fallback`);
      components = await this.detectByZones(imgBuffer, W, H);
    }

    const withBackground: NormalizedComponent[] = [
      {
        name: "Background",
        type: "BACKGROUND",
        imageUrl: "",
        box2d: [0, 0, 1000, 1000],
        confidence: 1,
      },
      ...components,
    ];

    const finalComponents = nms(withBackground);
    console.log(`[Gemini extract] ${finalComponents.length} components: ${finalComponents.map((c) => `${c.type}:${c.name}`).join(", ")}`);

    return { components: finalComponents };
  }

  async removeBackground(input: BgInput): Promise<PngResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${SEGMENTATION_MODEL}:generateContent?key=${this.apiKey}`;
    const prompt = `Segment the main subject of this image. Return a JSON object with:
{"box_2d": [y1, x1, y2, x2], "mask": "<base64 PNG grayscale mask, white=subject, black=background>"}
Coordinates 0-1000. Return ONLY the JSON, no other text.`;

    const imgBuffer = await this.fetchImageForSegmentation(input.imageUrl);
    const base64Image = imgBuffer.toString("base64");

    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: "image/png", data: base64Image } }] }],
        generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Gemini remove-bg error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    const candidate = data?.candidates?.[0];
    if (!candidate) throw new Error("Gemini remove-bg: no candidate");
    const textPart = candidate?.content?.parts?.find((p: any) => p.text);
    if (!textPart) throw new Error("Gemini remove-bg: no text response");

    const seg: SegmentationBox = parseJsonPayload(textPart.text);
    if (!seg.mask) return { imageUrl: "" };

    const sharp = await import("sharp");
    const maskData = Buffer.from(seg.mask, "base64");
    const imgMeta = await sharp.default(imgBuffer).metadata();
    const canvasW = imgMeta.width || 1024;
    const canvasH = imgMeta.height || 576;
    const box = normalizeBox(seg.box_2d);

    let maskCanvas: Buffer;
    if (box) {
      const [y1, x1, y2, x2] = box;
      const bx = Math.round((x1 / 1000) * canvasW);
      const by = Math.round((y1 / 1000) * canvasH);
      const bw = Math.max(1, Math.round(((x2 - x1) / 1000) * canvasW));
      const bh = Math.max(1, Math.round(((y2 - y1) / 1000) * canvasH));

      const resized = await sharp.default(maskData).resize(bw, bh, { fit: "fill" }).png().toBuffer();
      maskCanvas = await sharp.default({
        create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .composite([{ input: resized, left: bx, top: by }])
        .png()
        .toBuffer();
    } else {
      maskCanvas = await sharp.default(maskData).resize(canvasW, canvasH, { fit: "fill" }).png().toBuffer();
    }

    const alphaRaw = await sharp.default(maskCanvas)
      .resize(canvasW, canvasH, { fit: "fill" })
      .grayscale()
      .threshold(128)
      .raw()
      .toBuffer();

    const result = await sharp.default(imgBuffer)
      .removeAlpha()
      .joinChannel(alphaRaw, { raw: { width: canvasW, height: canvasH, channels: 1 } })
      .png()
      .toBuffer();

    return { imageUrl: `data:image/png;base64,${result.toString("base64")}` };
  }

  private async detectComponents(base64Image: string, prompt: string, W: number, H: number): Promise<NormalizedComponent[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${SEGMENTATION_MODEL}:generateContent?key=${this.apiKey}`;
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: "image/png", data: base64Image } }] }],
        generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: 0 }, responseMimeType: "application/json" },
      }),
    });

    if (!res.ok) {
      console.warn(`[Gemini extract] API error ${res.status}: ${await res.text()}`);
      return [];
    }

    const data = await res.json();
    const textPart = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.text);
    if (!textPart) return [];

    try {
      const parsed = parseJsonPayload(textPart.text);
      return coerceElements(parsed)
        .map((item, index) => {
          const box = normalizeBox(item.box_2d);
          if (!box) return null;
          const type = normalizeLabel(item.type || item.label);
          const name = item.name || item.label || `${type}_${index + 1}`;
          const areaPct = ((box[2] - box[0]) / 1000) * ((box[3] - box[1]) / 1000);
          if (areaPct < 0.00025 || areaPct > 0.92) return null;
          return { name, type, imageUrl: "", box2d: box, confidence: item.confidence ?? 0.75 };
        })
        .filter(Boolean) as NormalizedComponent[];
    } catch (err) {
      console.warn("[Gemini extract] parse failed:", err instanceof Error ? err.message : err);
      return [];
    }
  }

  private async detectByZones(imgBuffer: Buffer, W: number, H: number): Promise<NormalizedComponent[]> {
    const sharp = await import("sharp");
    const zones: { name: string; x: number; y: number; w: number; h: number; prompt: string }[] = [
      { name: "TOP", x: 0, y: 0, w: W, h: Math.round(H * 0.16), prompt: "Detect all top HUD UI components: avatar, bars, icons, badges, and buttons. Return JSON {\"elements\":[{\"name\":\"...\",\"type\":\"BAR\",\"box_2d\":[y1,x1,y2,x2],\"confidence\":0.9}]}. Coordinates 0-1000 relative to this crop." },
      { name: "LEFT", x: 0, y: 0, w: Math.round(W * 0.24), h: H, prompt: "Detect all left side UI icons, buttons, badges, and panels. Return JSON {\"elements\":[{\"name\":\"...\",\"type\":\"ICON\",\"box_2d\":[y1,x1,y2,x2],\"confidence\":0.9}]}. Coordinates 0-1000 relative to this crop." },
      { name: "RIGHT", x: Math.round(W * 0.76), y: 0, w: Math.round(W * 0.24), h: H, prompt: "Detect all right side UI icons, buttons, badges, and panels. Return JSON {\"elements\":[{\"name\":\"...\",\"type\":\"ICON\",\"box_2d\":[y1,x1,y2,x2],\"confidence\":0.9}]}. Coordinates 0-1000 relative to this crop." },
      { name: "CENTER", x: Math.round(W * 0.12), y: Math.round(H * 0.10), w: Math.round(W * 0.76), h: Math.round(H * 0.78), prompt: "Detect center UI components: main panels, cards, large buttons, characters, sprites, badges, and icons. Return JSON {\"elements\":[{\"name\":\"...\",\"type\":\"PANEL\",\"box_2d\":[y1,x1,y2,x2],\"confidence\":0.9}]}. Coordinates 0-1000 relative to this crop." },
      { name: "BOTTOM", x: 0, y: Math.round(H * 0.84), w: W, h: Math.round(H * 0.16), prompt: "Detect bottom navigation tabs, buttons, icons, badges, and bars. Return JSON {\"elements\":[{\"name\":\"...\",\"type\":\"BUTTON\",\"box_2d\":[y1,x1,y2,x2],\"confidence\":0.9}]}. Coordinates 0-1000 relative to this crop." },
    ];

    const results = await Promise.all(
      zones.map(async (zone) => {
        const cropBuffer = await sharp.default(imgBuffer)
          .extract({ left: zone.x, top: zone.y, width: zone.w, height: zone.h })
          .png()
          .toBuffer();
        const cropComponents = await this.detectComponents(cropBuffer.toString("base64"), zone.prompt, zone.w, zone.h);
        return cropComponents.map((component) => {
          const [y1, x1, y2, x2] = component.box2d;
          const y1Px = (y1 / 1000) * zone.h + zone.y;
          const x1Px = (x1 / 1000) * zone.w + zone.x;
          const y2Px = (y2 / 1000) * zone.h + zone.y;
          const x2Px = (x2 / 1000) * zone.w + zone.x;
          return {
            ...component,
            name: `${zone.name}_${component.name}`,
            box2d: [
              (y1Px / H) * 1000,
              (x1Px / W) * 1000,
              (y2Px / H) * 1000,
              (x2Px / W) * 1000,
            ] as [number, number, number, number],
          };
        });
      })
    );

    return nms(results.flat());
  }

  private async fetchImageForSegmentation(imageUrl: string): Promise<Buffer> {
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`Failed to fetch image for segmentation: ${res.status}`);
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  }
}
