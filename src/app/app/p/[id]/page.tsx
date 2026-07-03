import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Sparkles, Layers } from "lucide-react";
import { DeleteSceneButton } from "@/components/delete-scene-button";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, userId: session?.user?.id },
    include: {
      scenes: {
        include: {
          componentGroups: {
            include: { _count: { select: { assets: true } } },
          },
          _count: { select: { assets: true } },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!project) notFound();

  return (
    <div className="p-8">
      <div className="flex items-center gap-4 mb-8">
        <Link href="/app/projects">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-3xl font-bold">{project.name}</h1>
          {project.description && (
            <p className="text-muted-foreground">{project.description}</p>
          )}
        </div>
        <Link href={`/app/generate?projectId=${project.id}`}>
          <Button className="gap-2">
            <Sparkles className="w-4 h-4" />
            New Scene
          </Button>
        </Link>
      </div>

      {project.scenes.length === 0 ? (
        <Card className="text-center py-12">
          <CardContent>
            <Layers className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
            <CardTitle className="mb-2">No scenes yet</CardTitle>
            <CardDescription className="mb-4">
              Generate your first scene for this project.
            </CardDescription>
            <Link href={`/app/generate?projectId=${project.id}`}>
              <Button className="gap-2">
                <Sparkles className="w-4 h-4" />
                Generate Scene
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          {project.scenes.map((scene: any) => (
            <Card key={scene.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-base">
                      {scene.prompt.slice(0, 60)}
                      {scene.prompt.length > 60 ? "..." : ""}
                    </CardTitle>
                    <div className="flex gap-2 mt-2">
                      <Badge variant="secondary">{scene.type}</Badge>
                      <Badge variant="outline">{scene.ratio}</Badge>
                    </div>
                  </div>
                  <DeleteSceneButton sceneId={scene.id} />
                </div>
              </CardHeader>
              <CardContent>
                {scene.imageUrl && (
                  <div className="relative aspect-video rounded-lg overflow-hidden bg-muted mb-3">
                    <img
                      src={scene.imageUrl}
                      alt={scene.prompt}
                      className="w-full h-full object-cover"
                    />
                  </div>
                )}
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <span>{scene.componentGroups.length} groups</span>
                  <span>{scene._count.assets} assets</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}