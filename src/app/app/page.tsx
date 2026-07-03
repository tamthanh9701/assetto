import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Sparkles, FolderOpen, Layers, Download } from "lucide-react";

export default async function AppHome() {
  const session = await auth();
  const projectCount = await prisma.project.count({
    where: { userId: session?.user?.id },
  });
  const sceneCount = await prisma.scene.count({
    where: { project: { userId: session?.user?.id } },
  });
  const assetCount = await prisma.asset.count({
    where: { scene: { project: { userId: session?.user?.id } } },
  });

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">
          Welcome back{session?.user?.name ? `, ${session.user.name}` : ""}!
        </h1>
        <p className="text-muted-foreground">
          Manage your game assets and create new scenes.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3 mb-8">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Projects</CardTitle>
            <FolderOpen className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{projectCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Scenes</CardTitle>
            <Layers className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{sceneCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Assets</CardTitle>
            <Download className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{assetCount}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Generate a Scene</CardTitle>
            <CardDescription>
              Create a new game UI scene with AI.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/app/generate">
              <Button className="gap-2">
                <Sparkles className="w-4 h-4" />
                Start Generating
              </Button>
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>View Projects</CardTitle>
            <CardDescription>
              Browse your existing projects and scenes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/app/projects">
              <Button variant="outline" className="gap-2">
                <FolderOpen className="w-4 h-4" />
                Open Projects
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}