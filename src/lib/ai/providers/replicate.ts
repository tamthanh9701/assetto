import { ImageAIProvider, SceneInput, GenResult, ExtractInput, LayerResult, BgInput, PngResult } from "../types";

export class ReplicateProvider implements ImageAIProvider {
  private apiToken: string;

  constructor() {
    this.apiToken = process.env.REPLICATE_API_TOKEN || "";
  }

  async generateScene(input: SceneInput): Promise<GenResult> {
    const startTime = Date.now();
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "black-forest-labs/flux-schnell",
        input: {
          prompt: input.prompt,
          aspect_ratio: input.ratio || "16:9",
          num_outputs: 1,
          ...(input.seed ? { seed: input.seed } : {}),
        },
      }),
    });
    const data = await response.json();
    return { imageUrl: data.urls?.get || "", seed: input.seed, duration: Date.now() - startTime };
  }

  async extractLayers(input: ExtractInput): Promise<LayerResult> {
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "facebook/sam-2",
        input: { image: input.imageUrl },
      }),
    });
    const data = await response.json();
    return { components: [] };
  }

  async removeBackground(input: BgInput): Promise<PngResult> {
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "cjwbw/rembg:fb8af45114f238a0e3d7c5c3d5f1f8d8e8c8e8c8",
        input: { image: input.imageUrl },
      }),
    });
    const data = await response.json();
    return { imageUrl: data.urls?.get || "" };
  }
}