import { ImageAIProvider, SceneInput, GenResult, ExtractInput, LayerResult, BgInput, PngResult } from "../types";

export class GeminiProvider implements ImageAIProvider {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || "";
  }

  async generateScene(input: SceneInput): Promise<GenResult> {
    const startTime = Date.now();
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: input.prompt }] }],
          generationConfig: {
            ...(input.seed ? { seed: input.seed } : {}),
          },
        }),
      }
    );
    const data = await response.json();
    return { imageUrl: "", seed: input.seed, duration: Date.now() - startTime };
  }

  async extractLayers(_input: ExtractInput): Promise<LayerResult> {
    return { components: [] };
  }

  async removeBackground(_input: BgInput): Promise<PngResult> {
    return { imageUrl: "" };
  }
}