import { ImageAIProvider, SceneInput, GenResult, ExtractInput, LayerResult, BgInput, PngResult } from "../types";

const IMAGE_GEN_MODEL = "gemini-2.5-flash-image";
const SEGMENTATION_MODEL = "gemini-2.5-flash";

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

interface SegmentationBox {
  box_2d?: [number, number, number, number];
  mask?: string;
  label?: string;
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
  return inter / (areaA + areaB - inter);
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
                text: `Generate a game UI scene: ${input.prompt}. Aspect ratio: ${input.ratio || "16:9"}. Clean game UI design with clear sections for background, panels, buttons, icons, bars, and badges.`,
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
    const base64Image = imgBuffer.toString("base64");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${SEGMENTATION_MODEL}:generateContent?key=${this.apiKey}`;

    const prompt = `Detect ALL individual UI elements in this game UI image (every icon, button, bar, badge, panel, avatar, text label, etc). Do NOT group by type — list each element separately.
Return ONLY a JSON array: [{"box_2d":[y1,x1,y2,x2],"label":"BUTTON"},{"box_2d":[y1,x1,y2,x2],"label":"ICON"}, ...].
Coordinates normalized 0-1000. Maximum 30 elements. No mask, no extra text.`;

    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          { parts: [{ text: prompt }, { inlineData: { mimeType: "image/png", data: base64Image } }] },
        ],
        generationConfig: {
          temperature: 0,
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: "application/json",
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Gemini segmentation error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    const textPart = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.text);
    if (!textPart) throw new Error("Gemini segmentation: no text response");

    const rawText = textPart.text.trim();
    console.log(`[extractLayers] raw length=${rawText.length}`);

    let parsed: any;
    try {
      const arrMatch = rawText.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        parsed = JSON.parse(arrMatch[0]);
      } else {
        const objMatch = rawText.match(/\{[\s\S]*\}/);
        if (objMatch) {
          parsed = [JSON.parse(objMatch[0])];
        } else {
          throw new Error("No JSON found");
        }
      }
    } catch (e) {
      throw new Error(`Gemini segmentation parse error: ${e instanceof Error ? e.message : e}. Got: ${rawText.slice(0, 300)}`);
    }

    if (!Array.isArray(parsed)) parsed = [parsed];

    // Filter valid boxes
    interface Box { box2d: [number, number, number, number]; label: string; area: number }
    const boxes: Box[] = parsed
      .filter((s: any) => s.box_2d && Array.isArray(s.box_2d) && s.box_2d.length === 4 && s.label)
      .map((s: any) => ({
        box2d: s.box_2d as [number, number, number, number],
        label: s.label.toUpperCase(),
        area: (s.box_2d[2] - s.box_2d[0]) * (s.box_2d[3] - s.box_2d[1]),
      }));

    // NMS dedup: merge boxes with IoU > 0.6
    const nmsed: Box[] = [];
    boxes.sort((a, b) => b.area - a.area);
    for (const box of boxes) {
      let merged = false;
      for (const kept of nmsed) {
        const iou = computeIoU(box.box2d, kept.box2d);
        if (iou > 0.6 || (box.label === kept.label && iou > 0.3)) {
          kept.box2d = [
            Math.min(box.box2d[0], kept.box2d[0]),
            Math.min(box.box2d[1], kept.box2d[1]),
            Math.max(box.box2d[2], kept.box2d[2]),
            Math.max(box.box2d[3], kept.box2d[3]),
          ] as [number, number, number, number];
          merged = true;
          break;
        }
      }
      if (!merged) nmsed.push({ ...box });
    }

    // Filter tiny boxes (<1.5% area), cap at 40
    const filtered = nmsed
      .filter((b) => b.area > 1.5 * 1.5)
      .slice(0, 40);

    // Sort by position (row-major), then name by grid position
    const sorted = filtered.sort((a, b) => {
      const rowDiff = a.box2d[0] - b.box2d[0];
      return Math.abs(rowDiff) < 50 ? a.box2d[1] - b.box2d[1] : rowDiff;
    });

    const nameCounts: Record<string, number> = {};
    const components = sorted.map((s, idx) => {
      const baseType = s.label;
      nameCounts[baseType] = (nameCounts[baseType] || 0) + 1;
      const suffix = nameCounts[baseType] > 1 ? `_${nameCounts[baseType]}` : "";
      return {
        name: baseType.charAt(0) + baseType.slice(1).toLowerCase() + suffix,
        type: baseType,
        imageUrl: "",
        box2d: s.box2d,
      };
    });

    console.log(`[extractLayers] ${components.length} elements (from ${boxes.length} raw): ${components.map((c: any) => c.name).join(", ")}`);
    return { components };
  }

  async removeBackground(input: BgInput): Promise<PngResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${SEGMENTATION_MODEL}:generateContent?key=${this.apiKey}`;

    const prompt = `Segment the main subject of this image. Return a JSON object with:
{"box_2d": [y1, x1, y2, x2], "mask": "<base64 PNG grayscale mask, white=subject, black=background>"}
Coordinates 0–1000. Return ONLY the JSON, no other text.`;

    const imgBuffer = await this.fetchImageForSegmentation(input.imageUrl);
    const base64Image = imgBuffer.toString("base64");

    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          { parts: [{ text: prompt }, { inlineData: { mimeType: "image/png", data: base64Image } }] },
        ],
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

    const jsonMatch = textPart.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`Gemini remove-bg: no JSON found. Got: ${textPart.text.slice(0, 200)}`);
    const seg: SegmentationBox = JSON.parse(jsonMatch[0]);
    if (!seg.mask) return { imageUrl: "" };

    const sharp = await import("sharp");
    const maskData = Buffer.from(seg.mask, "base64");
    const imgMeta = await sharp.default(imgBuffer).metadata();
    const canvasW = imgMeta.width || 1024;
    const canvasH = imgMeta.height || 576;

    let maskCanvas: Buffer;
    if (seg.box_2d && seg.box_2d.length === 4) {
      const [y1, x1, y2, x2] = seg.box_2d;
      const bx = Math.round((x1 / 1000) * canvasW);
      const by = Math.round((y1 / 1000) * canvasH);
      const bw = Math.round(((x2 - x1) / 1000) * canvasW);
      const bh = Math.round(((y2 - y1) / 1000) * canvasH);

      const resized = await sharp.default(maskData)
        .resize(Math.max(1, bw), Math.max(1, bh), { fit: "fill" })
        .png()
        .toBuffer();

      maskCanvas = await sharp.default({
        create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .composite([{ input: resized, left: bx, top: by }])
        .png()
        .toBuffer();
    } else {
      maskCanvas = await sharp.default(maskData)
        .resize(canvasW, canvasH, { fit: "fill" })
        .png()
        .toBuffer();
    }

    // Get binary alpha channel via sharp threshold + raw
    const alphaRaw = await sharp.default(maskCanvas)
      .resize(canvasW, canvasH, { fit: "fill" })
      .grayscale()
      .threshold(128)
      .raw()
      .toBuffer();

    // Apply as alpha channel — removeAlpha + joinChannel with raw option
    const result = await sharp.default(imgBuffer)
      .removeAlpha()
      .joinChannel(alphaRaw, { raw: { width: canvasW, height: canvasH, channels: 1 } })
      .png()
      .toBuffer();

    return { imageUrl: `data:image/png;base64,${result.toString("base64")}` };
  }

  private async fetchImageForSegmentation(imageUrl: string): Promise<Buffer> {
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`Failed to fetch image for segmentation: ${res.status}`);
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  }
}