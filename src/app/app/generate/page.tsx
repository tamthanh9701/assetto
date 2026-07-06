"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Layers, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

const sceneTypes = [
  { value: "MENU", label: "Menu" },
  { value: "HUD", label: "HUD" },
  { value: "LOADING", label: "Loading" },
  { value: "SETTINGS", label: "Settings" },
  { value: "INVENTORY", label: "Inventory" },
  { value: "SHOP", label: "Shop" },
  { value: "DIALOGUE", label: "Dialogue" },
  { value: "CUSTOM", label: "Custom" },
];

type ProjectOption = { id: string; name: string };

type SceneResult = {
  id: string;
  imageUrl: string;
  prompt: string;
};

type ExtractAsset = {
  id: string;
  name: string;
  type: string;
  subType?: string | null;
  pngUrl: string | null;
  transparent?: boolean;
};

type ExtractJob = {
  id: string;
  sceneId?: string | null;
  status: "pending" | "processing" | "completed" | "failed" | string;
  progress: number;
  resultZipUrl?: string | null;
  error?: string | null;
  assets?: ExtractAsset[];
};

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function GeneratePage() {
  const searchParams = useSearchParams();
  const [prompt, setPrompt] = useState("");
  const [sceneType, setSceneType] = useState("MENU");
  const [ratio, setRatio] = useState("9:16");
  const [quality, setQuality] = useState("standard");
  const [projectId, setProjectId] = useState<string>(
    searchParams.get("projectId") || ""
  );
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [generating, setGenerating] = useState(false);
  const [sceneResult, setSceneResult] = useState<SceneResult | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractJob, setExtractJob] = useState<ExtractJob | null>(null);
  const [components, setComponents] = useState<ExtractAsset[]>([]);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data) => setProjects(data));
  }, []);

  async function generateScene(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) {
      toast.error("Please select a project");
      return;
    }

    setGenerating(true);
    setSceneResult(null);
    setExtractJob(null);
    setComponents([]);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, type: sceneType, ratio, quality, projectId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Generation failed");
      }
      const data = await res.json();
      setSceneResult(data);
      toast.success("Scene generated!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate scene");
    } finally {
      setGenerating(false);
    }
  }

  async function pollExtractJob(jobId: string) {
    for (let attempt = 0; attempt < 180; attempt++) {
      const res = await fetch(`/api/extract/jobs/${jobId}`, { cache: "no-store" });
      if (!res.ok) {
        throw new Error("Failed to read extraction job");
      }

      const job: ExtractJob = await res.json();
      setExtractJob(job);

      if (job.status === "completed") {
        const assets = (job.assets || []).filter((asset) => Boolean(asset.pngUrl));
        setComponents(assets);
        toast.success(`Extracted ${assets.length} assets`);
        return;
      }

      if (job.status === "failed") {
        throw new Error(job.error || "Extraction failed");
      }

      await wait(2000);
    }

    throw new Error("Extraction is still running. Please refresh the job status later.");
  }

  async function extractLayers() {
    if (!sceneResult) return;

    setExtracting(true);
    setExtractJob(null);
    setComponents([]);

    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sceneId: sceneResult.id,
          imageUrl: sceneResult.imageUrl,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Extraction failed");
      }
      const data = await res.json();
      setExtractJob({ id: data.jobId, status: data.status, progress: 0 });
      await pollExtractJob(data.jobId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to extract layers");
    } finally {
      setExtracting(false);
    }
  }

  const progress = extractJob?.progress ?? 0;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Generate Scene</h1>
        <p className="text-muted-foreground">
          Create a new game UI scene with AI, extract reusable assets, and export PNG/ZIP files.
        </p>
      </div>

      <Tabs defaultValue="generate" className="space-y-6">
        <TabsList>
          <TabsTrigger value="generate" className="gap-2">
            <Sparkles className="w-4 h-4" />
            Generate
          </TabsTrigger>
          <TabsTrigger value="extract" className="gap-2" disabled={!sceneResult}>
            <Layers className="w-4 h-4" />
            Extract Layers
          </TabsTrigger>
          <TabsTrigger value="export" className="gap-2" disabled={components.length === 0}>
            <Download className="w-4 h-4" />
            Export
          </TabsTrigger>
        </TabsList>

        <TabsContent value="generate">
          <Card>
            <CardHeader>
              <CardTitle>Scene Details</CardTitle>
              <CardDescription>
                Describe the game UI scene you want to create.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={generateScene} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="project">Project</Label>
                  <Select value={projectId} onValueChange={(v) => v && setProjectId(v)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a project" />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="prompt">Prompt</Label>
                  <Textarea
                    id="prompt"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Describe your game UI scene, e.g., 'A futuristic RPG menu with neon blue buttons and dark purple background'"
                    required
                    rows={4}
                  />
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>Scene Type</Label>
                    <Select value={sceneType} onValueChange={(v) => v && setSceneType(v)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {sceneTypes.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Aspect Ratio</Label>
                    <Select value={ratio} onValueChange={(v) => v && setRatio(v)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="9:16">9:16 (Portrait)</SelectItem>
                        <SelectItem value="16:9">16:9 (Landscape)</SelectItem>
                        <SelectItem value="1:1">1:1 (Square)</SelectItem>
                        <SelectItem value="4:3">4:3</SelectItem>
                        <SelectItem value="3:4">3:4</SelectItem>
                        <SelectItem value="21:9">21:9 (Ultrawide)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Quality</Label>
                    <Select value={quality} onValueChange={(v) => v && setQuality(v)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="draft">Draft (Fast)</SelectItem>
                        <SelectItem value="standard">Standard</SelectItem>
                        <SelectItem value="premium">Premium</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <Button type="submit" className="w-full gap-2" disabled={generating}>
                  {generating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" /> Generating...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" /> Generate Scene
                    </>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>

          {sceneResult && (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Generated Scene</CardTitle>
                <CardDescription>{sceneResult.prompt.slice(0, 100)}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="relative aspect-video rounded-lg overflow-hidden bg-muted">
                  <img
                    src={sceneResult.imageUrl}
                    alt={sceneResult.prompt}
                    className="w-full h-full object-cover"
                  />
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="extract">
          <Card>
            <CardHeader>
              <CardTitle>Extract Layers</CardTitle>
              <CardDescription>
                Run the async extraction worker, track progress, and load extracted assets when done.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button onClick={extractLayers} disabled={extracting || !sceneResult} className="gap-2">
                {extracting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Extracting...
                  </>
                ) : (
                  <>
                    <Layers className="w-4 h-4" /> Extract Components
                  </>
                )}
              </Button>

              {extractJob && (
                <div className="space-y-2 rounded-lg border p-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">Status: {extractJob.status}</span>
                    <span>{progress}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
                  </div>
                  {extractJob.error && <p className="text-sm text-destructive">{extractJob.error}</p>}
                </div>
              )}

              {components.length > 0 && (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4">
                  {components.map((comp) => (
                    <Card key={comp.id}>
                      <CardContent className="p-3">
                        <div className="aspect-square rounded-md overflow-hidden bg-muted mb-2">
                          {comp.pngUrl && (
                            <img
                              src={comp.pngUrl}
                              alt={comp.name}
                              className="w-full h-full object-contain"
                            />
                          )}
                        </div>
                        <p className="text-sm font-medium truncate">{comp.name}</p>
                        <div className="flex gap-1 mt-1">
                          <Badge variant="secondary">{comp.type}</Badge>
                          {comp.subType && <Badge variant="outline">{comp.subType}</Badge>}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="export">
          <Card>
            <CardHeader>
              <CardTitle>Export Assets</CardTitle>
              <CardDescription>
                Download extracted components as transparent PNGs or as a ZIP archive.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2 mb-4">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => {
                    if (sceneResult?.id) {
                      window.open(`/api/export?sceneId=${sceneResult.id}&format=zip`, "_blank");
                    }
                  }}
                  disabled={!sceneResult?.id}
                >
                  <Download className="w-4 h-4" /> Download All as ZIP
                </Button>
              </div>
              <div className="space-y-2">
                {components.map((comp) => (
                  <div key={comp.id} className="flex items-center justify-between p-3 rounded-lg border">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded bg-muted overflow-hidden">
                        {comp.pngUrl && (
                          <img src={comp.pngUrl} alt={comp.name} className="w-full h-full object-contain" />
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-medium">{comp.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {comp.type}{comp.subType ? ` / ${comp.subType}` : ""}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => window.open(`/api/export?assetId=${comp.id}`, "_blank")}
                    >
                      <Download className="w-4 h-4 mr-1" /> Download
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
