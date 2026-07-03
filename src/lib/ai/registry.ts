import { ImageAIProvider } from "./types";
import { ReplicateProvider } from "./providers/replicate";
import { GeminiProvider } from "./providers/gemini";

const providerInstances = new Map<string, ImageAIProvider>();

function getProviderInstance(name: string): ImageAIProvider {
  if (!providerInstances.has(name)) {
    switch (name) {
      case "replicate":
        providerInstances.set(name, new ReplicateProvider());
        break;
      case "gemini":
        providerInstances.set(name, new GeminiProvider());
        break;
      default:
        throw new Error(`Unknown provider: ${name}`);
    }
  }
  return providerInstances.get(name)!;
}

function getConfig() {
  return {
    generate: process.env.AI_PROVIDER_GENERATE || "gemini",
    extract: process.env.AI_PROVIDER_EXTRACT || "gemini",
    removebg: process.env.AI_PROVIDER_REMOVEBG || "gemini",
  };
}

export function getProvider(step: "generate" | "extract" | "removebg"): ImageAIProvider {
  const config = getConfig();
  return getProviderInstance(config[step]);
}

export function registerProvider(name: string, instance: ImageAIProvider): void {
  providerInstances.set(name, instance);
}