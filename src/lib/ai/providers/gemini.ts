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
    const componentTypes = input.componentTypes ?? [
      "BACKGROUND", "PANEL", "BUTTON", "ICON", "BADGE", "BAR",
    ];

    const imgBuffer = await this.fetchImageForSegmentation(input.imageUrl);
    const base64Image = imgBuffer.toString("base64");
    const sharp = await import("sharp");
    const imgMeta = await sharp.default(imgBuffer).metadata();
    const canvasW = imgMeta.width || 1024;
    const canvasH = imgMeta.height || 576;

    // Tách 1 call / component, chạy song song
    const results = await Promise.all(
      componentTypes.map(async (type, _i) => {
        const label = type.charAt(0) + type.slice(1).toLowerCase();
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${SEGMENTATION_MODEL}:generateContent?key=${this.apiKey}`;

          const prompt = `Segment this game UI image and find the "${label}" component. Return a JSON object:
{"box_2d": [y1, x1, y2, x2], "mask": "<base64 PNG grayscale mask>"}
Coordinates 0-1000. Mask grayscale PNG, white=keep, black=discard.
If "${label}" is not found, return an empty object {}.
Return ONLY the JSON, no other text.`;

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
                maxOutputTokens: 8192,
                responseMimeType: "application/json",
              },
            }),
          });

          if (!res.ok) {
            const errBody = await res.text();
            console.warn(`[extractLayers] ${label} API error ${res.status}: ${errBody.slice(0, 200)}`);
            return null;
          }

          const data = await res.json();
          const textPart = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.text);
          if (!textPart) {
            console.warn(`[extractLayers] ${label}: no text response`);
            return null;
          }

          const rawText = textPart.text.trim();
          console.log(`[extractLayers] ${label}: raw length=${rawText.length}`);

          const jsonMatch = rawText.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            console.warn(`[extractLayers] ${label}: no JSON. Got: ${rawText.slice(0, 100)}`);
            return null;
          }

          const seg: SegmentationBox = JSON.parse(jsonMatch[0]);
          if (!seg.mask) {
            console.warn(`[extractLayers] ${label}: no mask in response`);
            return null;
          }

          // Strip data URL prefix if present
          let maskB64 = seg.mask;
          if (maskB64.includes("base64,")) {
            maskB64 = maskB64.split("base64,")[1];
          }

          const maskData = Buffer.from(maskB64, "base64");
          let maskCanvas: Buffer;

          if (seg.box_2d && seg.box_2d.length === 4) {
            let [y1, x1, y2, x2] = seg.box_2d;
            // Clamp coordinates to valid range
            y1 = Math.max(0, Math.min(1000, y1));
            x1 = Math.max(0, Math.min(1000, x1));
            y2 = Math.max(0, Math.min(1000, y2));
            x2 = Math.max(0, Math.min(1000, x2));
            if (x2 <= x1 || y2 <= y1) {
              // Invalid box, resize mask to full canvas
              maskCanvas = await sharp.default(maskData)
                .resize(canvasW, canvasH, { fit: "fill" })
                .png()
                .toBuffer();
            } else {
              const bx = Math.round((x1 / 1000) * canvasW);
              const by = Math.round((y1 / 1000) * canvasH);
              let bw = Math.round(((x2 - x1) / 1000) * canvasW);
              let bh = Math.round(((y2 - y1) / 1000) * canvasH);
              // Clamp within canvas
              bw = Math.min(bw, canvasW - bx);
              bh = Math.min(bh, canvasH - by);

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
            }
          } else {
            maskCanvas = await sharp.default(maskData)
              .resize(canvasW, canvasH, { fit: "fill" })
              .png()
              .toBuffer();
          }

          const binaryMask = await sharp.default(maskCanvas)
            .grayscale()
            .threshold(128)
            .png()
            .toBuffer();

          return {
            name: label,
            type: type,
            imageUrl: "",
            maskUrl: `data:image/png;base64,${binaryMask.toString("base64")}`,
          };
        } catch (err) {
          console.warn(`[extractLayers] ${label} failed:`, err instanceof Error ? err.message : err);
          return null;
        }
      })
    );

    const components = results.filter((r): r is NonNullable<typeof r> => r !== null);
    console.log(`[extractLayers] ${components.length}/${componentTypes.length} components extracted`);
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