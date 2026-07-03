import { ImageAIProvider, SceneInput, GenResult, ExtractInput, LayerResult, BgInput, PngResult } from "../types";

async function pollGeneration(url: string, apiKey: string, maxRetries = 60, interval = 1000): Promise<any> {
  for (let i = 0; i < maxRetries; i++) {
    const res = await fetch(url, {
      headers: { "x-goog-api-key": apiKey },
    });
    const data = await res.json();
    if (data.done) return data;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("Gemini generation timed out");
}

export class GeminiProvider implements ImageAIProvider {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || "";
  }

  async generateScene(input: SceneInput): Promise<GenResult> {
    const startTime = Date.now();
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: `Generate a game UI scene: ${input.prompt}. Aspect ratio: ${input.ratio || "16:9"}` }],
            },
          ],
          generationConfig: {
            responseModalities: ["Text", "Image"],
            ...(input.seed ? { seed: input.seed } : {}),
          },
        }),
      }
    );
    const data = await res.json();
    const candidate = data?.candidates?.[0];
    const part = candidate?.content?.parts?.find((p: any) => p.inlineData);
    const imageUrl = part?.inlineData?.data
      ? `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
      : "";
    return { imageUrl, seed: input.seed, duration: Date.now() - startTime };
  }

  async extractLayers(_input: ExtractInput): Promise<LayerResult> {
    return { components: [] };
  }

  async removeBackground(_input: BgInput): Promise<PngResult> {
    return { imageUrl: "" };
  }
}