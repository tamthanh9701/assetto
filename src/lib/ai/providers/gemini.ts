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
    const sharp = await import("sharp");
    const imgMeta = await sharp.default(imgBuffer).metadata();
    const W = imgMeta.width || 1024;
    const H = imgMeta.height || 576;

    // 5 zones: TOP, LEFT, RIGHT, CENTER, BOTTOM
    const zones: { name: string; x: number; y: number; w: number; h: number; prompt: string }[] = [
      {
        name: "TOP",
        x: 0, y: 0, w: W, h: Math.round(H * 0.12),
        prompt: `Detect ALL individual UI elements in the TOP strip of this game UI image. Include the avatar in the top-left corner and EACH resource bar (peach/coin/gem/star) — each bar as a separate BAR element including its icon+number+plus button. Return ONLY a JSON array: [{"box_2d":[y1,x1,y2,x2],"label":"AVATAR"},{"box_2d":[y1,x1,y2,x2],"label":"BAR"},...]. Coordinates normalized 0-1000 relative to THIS crop. Maximum 10 elements. No mask.`,
      },
      {
        name: "LEFT",
        x: 0, y: 0, w: Math.round(W * 0.20), h: H,
        prompt: `Detect ALL round icon buttons on the LEFT side of this game UI image. Return ONLY a JSON array: [{"box_2d":[y1,x1,y2,x2],"label":"ICON"},...]. Coordinates normalized 0-1000 relative to THIS crop. Maximum 10 elements. No mask.`,
      },
      {
        name: "RIGHT",
        x: Math.round(W * 0.80), y: 0, w: Math.round(W * 0.20), h: H,
        prompt: `Detect ALL round icon buttons on the RIGHT side of this game UI image. Return ONLY a JSON array: [{"box_2d":[y1,x1,y2,x2],"label":"ICON"},...]. Coordinates normalized 0-1000 relative to THIS crop. Maximum 10 elements. No mask.`,
      },
      {
        name: "CENTER",
        x: Math.round(W * 0.20), y: Math.round(H * 0.12), w: Math.round(W * 0.60), h: Math.round(H * 0.76),
        prompt: `Detect ALL UI elements in the CENTER area of this game UI image. Include the main panel, any large BATTLE button, and any large illustration/character artwork (label as ILLUSTRATION). Return ONLY a JSON array: [{"box_2d":[y1,x1,y2,x2],"label":"PANEL"},{"box_2d":[y1,x1,y2,x2],"label":"BUTTON"},{"box_2d":[y1,x1,y2,x2],"label":"ILLUSTRATION"},{"box_2d":[y1,x1,y2,x2],"label":"BADGE"},...]. Coordinates normalized 0-1000 relative to THIS crop. Maximum 10 elements. No mask.`,
      },
      {
        name: "BOTTOM",
        x: 0, y: Math.round(H * 0.88), w: W, h: Math.round(H * 0.12),
        prompt: `Detect ALL navigation tab buttons at the BOTTOM of this game UI image. EACH tab is a separate BUTTON (Shop, Heroes, Battle, Character, Gameplay). Also detect any badge icons. Return ONLY a JSON array: [{"box_2d":[y1,x1,y2,x2],"label":"BUTTON"},{"box_2d":[y1,x1,y2,x2],"label":"BADGE"},...]. Coordinates normalized 0-1000 relative to THIS crop. Maximum 10 elements. No mask.`,
      },
    ];

    const zoneResults = await Promise.all(
      zones.map(async (zone) => {
        try {
          const cropBuffer = await sharp.default(imgBuffer)
            .extract({ left: zone.x, top: zone.y, width: zone.w, height: zone.h })
            .png()
            .toBuffer();
          const base64 = cropBuffer.toString("base64");
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${SEGMENTATION_MODEL}:generateContent?key=${this.apiKey}`;

          const res = await fetchWithRetry(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: zone.prompt }, { inlineData: { mimeType: "image/png", data: base64 } }] }],
              generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: 0 }, responseMimeType: "application/json" },
            }),
          });

          if (!res.ok) {
            console.warn(`[extractLayers] ${zone.name} API error ${res.status}`);
            return [];
          }

          const data = await res.json();
          const textPart = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.text);
          if (!textPart) return [];

          const rawText = textPart.text.trim();
          let parsed: any;
          const arrMatch = rawText.match(/\[[\s\S]*\]/);
          if (arrMatch) {
            parsed = JSON.parse(arrMatch[0]);
          } else {
            const objMatch = rawText.match(/\{[\s\S]*\}/);
            if (objMatch) parsed = [JSON.parse(objMatch[0])];
            else return [];
          }

          if (!Array.isArray(parsed)) parsed = [parsed];

          // Offset coordinates back to full image, filter invalid
          return parsed
            .filter((s: any) => s.box_2d && Array.isArray(s.box_2d) && s.box_2d.length === 4 && s.label)
            .map((s: any) => ({
              box2d: [
                s.box_2d[0] / 1000 * zone.h + zone.y,
                s.box_2d[1] / 1000 * zone.w + zone.x,
                s.box_2d[2] / 1000 * zone.h + zone.y,
                s.box_2d[3] / 1000 * zone.w + zone.x,
              ] as [number, number, number, number],
              label: s.label.toUpperCase(),
              area: ((s.box_2d[2] - s.box_2d[0]) / 1000 * zone.h) * ((s.box_2d[3] - s.box_2d[1]) / 1000 * zone.w),
            }));
        } catch (e) {
          console.warn(`[extractLayers] ${zone.name} failed:`, e);
          return [];
        }
      })
    );

    // Flatten all zones
    const allBoxes = zoneResults.flat();
    console.log(`[extractLayers] raw boxes: ${allBoxes.length} (zones: ${zones.map((z, i) => `${z.name}=${zoneResults[i].length}`).join(", ")})`);

    // NMS dedup + filtering
    interface Box { box2d: [number, number, number, number]; label: string; area: number }
    const nmsed: Box[] = [];
    allBoxes.sort((a, b) => b.area - a.area);

    for (const box of allBoxes) {
      // Filter tiny (<0.8%) or too large (>70%) — except BACKGROUND/ILLUSTRATION
      const fullArea = W * H;
      const pct = box.area / fullArea;
      if (pct < 0.008 && !["ILLUSTRATION"].includes(box.label)) continue;
      if (pct > 0.70 && !["BACKGROUND", "ILLUSTRATION"].includes(box.label)) continue;

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

    // Sort by position (row-major), cap at 40
    const sorted = nmsed.sort((a, b) => {
      const rowDiff = a.box2d[0] - b.box2d[0];
      return Math.abs(rowDiff) < 50 ? a.box2d[1] - b.box2d[1] : rowDiff;
    }).slice(0, 40);

    const nameCounts: Record<string, number> = {};
    const components = sorted.map((s) => {
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

    console.log(`[extractLayers] ${components.length} final: ${components.map((c: any) => c.name).join(", ")}`);
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