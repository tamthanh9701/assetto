import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/ai/registry";
import { persistImage, persistBase64Image } from "@/lib/storage";

export const maxDuration = 120;

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

    // Persist ảnh vào storage vĩnh viễn
    const isDataUrl = result.imageUrl.startsWith("data:");
    const permanentUrl = isDataUrl
      ? await persistBase64Image(result.imageUrl, `scene_${projectId.slice(0, 8)}`)
      : await persistImage(result.imageUrl, `scene_${projectId.slice(0, 8)}`);

    const scene = await prisma.scene.create({
      data: {
        prompt,
        type: (type as any) || "CUSTOM",
        ratio: ratio || "16:9",
        quality: quality || "standard",
        imageUrl: permanentUrl,
        seed: result.seed,
        projectId,
      },
    });

    await prisma.generation.create({
      data: {
        status: permanentUrl ? "completed" : "failed",
        provider: providerName,
        prompt,
        resultUrl: permanentUrl,
        duration: result.duration,
        sceneId: scene.id,
      },
    });

    return NextResponse.json({
      id: scene.id,
      imageUrl: permanentUrl,
      prompt,
      seed: result.seed,
    });
  } catch (err) {
    console.error("Generate error:", err);
    return NextResponse.json({ error: "Generation failed" }, { status: 500 });
  }
}