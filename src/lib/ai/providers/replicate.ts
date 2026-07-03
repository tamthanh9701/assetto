import { ImageAIProvider, SceneInput, GenResult, ExtractInput, LayerResult, BgInput, PngResult } from "../types";

const POLL_RETRIES = 120;
const POLL_INTERVAL = 1000;

async function pollPrediction(
  url: string,
  token: string,
  maxRetries = POLL_RETRIES,
  interval = POLL_INTERVAL
): Promise<any> {
  for (let i = 0; i < maxRetries; i++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
    const data = await res.json();
    if (data.status === "succeeded") return data;
    if (data.status === "failed") throw new Error(`Replicate prediction failed: ${data.error}`);
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("Replicate prediction timed out");
}

const MODEL_VERSIONS = {
  "flux-schnell": "black-forest-labs/flux-schnell",
  "flux-pro": "black-forest-labs/flux-pro",
  sam2: "facebook/sam-2",
  rembg: "cjwbw/rembg",
} as const;

export class ReplicateProvider implements ImageAIProvider {
  private apiToken: string;

  constructor() {
    this.apiToken = process.env.REPLICATE_API_TOKEN || "";
  }

  async generateScene(input: SceneInput): Promise<GenResult> {
    const startTime = Date.now();
    const res = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify({
        version: MODEL_VERSIONS["flux-schnell"],
        input: {
          prompt: input.prompt,
          aspect_ratio: input.ratio || "16:9",
          num_outputs: 1,
          num_inference_steps: 4,
          ...(input.seed ? { seed: input.seed } : {}),
        },
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Replicate API error ${res.status}: ${errBody}`);
    }
    const data = await res.json();
    if (data.status === "succeeded") {
      return {
        imageUrl: Array.isArray(data.output) ? data.output[0] : data.output,
        seed: input.seed,
        duration: Date.now() - startTime,
      };
    }
    const polled = await pollPrediction(data.urls?.get, this.apiToken);
    return {
      imageUrl: Array.isArray(polled.output) ? polled.output[0] : polled.output,
      seed: input.seed,
      duration: Date.now() - startTime,
    };
  }

  async extractLayers(input: ExtractInput): Promise<LayerResult> {
    const startTime = Date.now();
    const res = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: MODEL_VERSIONS.sam2,
        input: { image: input.imageUrl },
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Replicate SAM error ${res.status}: ${errBody}`);
    }
    const data = await res.json();
    const polled = await pollPrediction(data.urls?.get, this.apiToken);
    const maskUrl = Array.isArray(polled.output) ? polled.output[0] : polled.output;
    const types = input.componentTypes ?? [
      "BACKGROUND", "PANEL", "BUTTON", "ICON", "BADGE", "BAR",
    ];
    const components = types.map((type) => ({
      name: type.charAt(0) + type.slice(1).toLowerCase(),
      type,
      imageUrl: maskUrl,
      maskUrl,
    }));
    return { components };
  }

  async removeBackground(input: BgInput): Promise<PngResult> {
    const startTime = Date.now();
    const res = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: MODEL_VERSIONS.rembg,
        input: { image: input.imageUrl },
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Replicate rembg error ${res.status}: ${errBody}`);
    }
    const data = await res.json();
    const polled = await pollPrediction(data.urls?.get, this.apiToken);
    return {
      imageUrl: Array.isArray(polled.output) ? polled.output[0] : polled.output,
    };
  }
}