import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/ai/registry";

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { prompt, type, ratio, quality, projectId } = await req.json();
    if (!prompt || !projectId) {
      return NextResponse.json({ error: "Prompt and projectId required" }, { status: 400 });
    }

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: session.user.id },
    });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const providerName = process.env.AI_PROVIDER_GENERATE || "replicate";
    const provider = getProvider("generate");
    const result = await provider.generateScene({ prompt, type, ratio, quality });

    const scene = await prisma.scene.create({
      data: {
        prompt,
        type: (type as any) || "CUSTOM",
        ratio: ratio || "16:9",
        quality: quality || "standard",
        imageUrl: result.imageUrl,
        seed: result.seed,
        projectId,
      },
    });

    await prisma.generation.create({
      data: {
        status: result.imageUrl ? "completed" : "failed",
        provider: providerName,
        prompt,
        resultUrl: result.imageUrl,
        duration: result.duration,
        sceneId: scene.id,
      },
    });

    return NextResponse.json({
      id: scene.id,
      imageUrl: result.imageUrl,
      prompt,
      seed: result.seed,
    });
  } catch (err) {
    console.error("Generate error:", err);
    return NextResponse.json({ error: "Generation failed" }, { status: 500 });
  }
}