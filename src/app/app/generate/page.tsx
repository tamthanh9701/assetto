"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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

export default function GeneratePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [prompt, setPrompt] = useState("");
  const [sceneType, setSceneType] = useState("MENU");
  const [ratio, setRatio] = useState("9:16");
  const [quality, setQuality] = useState("standard");
  const [projectId, setProjectId] = useState<string>(
    searchParams.get("projectId") || ""
  );
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [generating, setGenerating] = useState(false);
  const [sceneResult, setSceneResult] = useState<{
    id: string;
    imageUrl: string;
    prompt: string;
  } | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [components, setComponents] = useState<
    { name: string; type: string; imageUrl: string }[]
  >([]);

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
    setComponents([]);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, type: sceneType, ratio, quality, projectId }),
      });
      if (!res.ok) throw new Error("Generation failed");
      const data = await res.json();
      setSceneResult(data);
      toast.success("Scene generated!");
    } catch {
      toast.error("Failed to generate scene");
    }
    setGenerating(false);
  }

  async function extractLayers() {
    if (!sceneResult) return;
    setExtracting(true);
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sceneId: sceneResult.id,
          imageUrl: sceneResult.imageUrl,
        }),
      });
      if (!res.ok) throw new Error("Extraction failed");
      const data = await res.json();
      setComponents(data.components);
      toast.success("Layers extracted!");
    } catch {
      toast.error("Failed to extract layers");
    }
    setExtracting(false);
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Generate Scene</h1>
        <p className="text-muted-foreground">
          Create a new game UI scene with AI.
        </p>
      </div>

      <Tabs defaultValue="generate" className="space-y-6">
        <TabsList>
          <TabsTrigger value="generate" className="gap-2">
            <Sparkles className="w-4 h-4" />
            Generate
          </TabsTrigger>
          <TabsTrigger
            value="extract"
            className="gap-2"
            disabled={!sceneResult}
          >
            <Layers className="w-4 h-4" />
            Extract Layers
          </TabsTrigger>
          <TabsTrigger
            value="export"
            className="gap-2"
            disabled={components.length === 0}
          >
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

                <Button
                  type="submit"
                  className="w-full gap-2"
                  disabled={generating}
                >
                  {generating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />{" "}
                      Generating...
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
                <CardDescription>
                  {sceneResult.prompt.slice(0, 100)}
                </CardDescription>
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
                Separate the scene into individual components.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button
                onClick={extractLayers}
                disabled={extracting || !sceneResult}
                className="gap-2"
              >
                {extracting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />{" "}
                    Extracting...
                  </>
                ) : (
                  <>
                    <Layers className="w-4 h-4" /> Extract Components
                  </>
                )}
              </Button>

              {components.length > 0 && (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4">
                  {components.map((comp, i) => (
                    <Card key={i}>
                      <CardContent className="p-3">
                        <div className="aspect-square rounded-md overflow-hidden bg-muted mb-2">
                          <img
                            src={comp.imageUrl}
                            alt={comp.name}
                            className="w-full h-full object-contain"
                          />
                        </div>
                        <p className="text-sm font-medium truncate">
                          {comp.name}
                        </p>
                        <Badge variant="secondary" className="mt-1">
                          {comp.type}
                        </Badge>
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
                Download your components as transparent PNGs.
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
                {components.map((comp, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between p-3 rounded-lg border"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded bg-muted overflow-hidden">
                        <img
                          src={comp.imageUrl}
                          alt={comp.name}
                          className="w-full h-full object-contain"
                        />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{comp.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {comp.type}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const assetId = comp.imageUrl.split("/").pop()?.split(".")[0];
                        if (assetId) {
                          window.open(`/api/export?assetId=${assetId}`, "_blank");
                        } else {
                          window.open(comp.imageUrl, "_blank");
                        }
                      }}
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