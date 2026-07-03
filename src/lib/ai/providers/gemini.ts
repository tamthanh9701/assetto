import { ImageAIProvider, SceneInput, GenResult, ExtractInput, LayerResult, BgInput, PngResult } from "../types";

const GEMINI_MODEL = "gemini-3.1-flash-lite-image";

export class GeminiProvider implements ImageAIProvider {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || "";
  }

  async generateScene(input: SceneInput): Promise<GenResult> {
    const startTime = Date.now();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `Generate a game UI scene: ${input.prompt}. Aspect ratio: ${input.ratio || "16:9"}`,
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["Text", "Image"],
          ...(input.seed ? { seed: input.seed } : {}),
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
      throw new Error(`Gemini blocked. Reason: ${reason}. Full response: ${JSON.stringify(data)}`);
    }
    const part = candidate?.content?.parts?.find((p: any) => p.inlineData);
    const imageUrl = part?.inlineData?.data
      ? `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
      : "";
    if (!imageUrl) {
      const textPart = candidate?.content?.parts?.find((p: any) => p.text);
      throw new Error(`Gemini returned no image. Text response: ${textPart?.text || "none"}`);
    }
    return { imageUrl, seed: input.seed, duration: Date.now() - startTime };
  }

  async extractLayers(_input: ExtractInput): Promise<LayerResult> {
    return { components: [] };
  }

  async removeBackground(_input: BgInput): Promise<PngResult> {
    return { imageUrl: "" };
  }
}