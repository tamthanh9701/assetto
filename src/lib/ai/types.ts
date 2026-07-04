export interface SceneInput {
  prompt: string;
  type?: string;
  ratio?: string;
  quality?: string;
  styleRefUrl?: string;
  seed?: number;
}

export interface GenResult {
  imageUrl: string;
  seed?: number;
  duration?: number;
}

export interface ExtractInput {
  imageUrl: string;
  componentTypes?: string[];
}

export interface LayerResult {
  components: {
    name: string;
    type: string;
    imageUrl: string;
    maskUrl?: string;
    box2d?: [number, number, number, number];
  }[];
}

export interface BgInput {
  imageUrl: string;
}

export interface PngResult {
  imageUrl: string;
  maskUrl?: string;
}

export interface ImageAIProvider {
  generateScene(input: SceneInput): Promise<GenResult>;
  extractLayers(input: ExtractInput): Promise<LayerResult>;
  removeBackground(input: BgInput): Promise<PngResult>;
}