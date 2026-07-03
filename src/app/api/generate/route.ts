import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/ai/registry";
import { persistImage, persistBase64Image } from "@/lib/storage";
import { checkRateLimit } from "@/lib/rate-limit";

export const maxDuration = 120;

export async function POST(req: Request) {
  let sceneId: string | null = null;

  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const quota = await checkRateLimit(session.user.id);
    if (!quota.allowed) {
      return NextResponse.json(
        { error: `Daily limit reached (${quota.limit} generations).`, quota },
        { status: 429 }
      );
    }

    const { prompt, type, ratio, quality, projectId } = await req.json();
    if (!prompt || !projectId) {
      return NextResponse.json({ error: "Prompt and projectId required" }, { status: 400 });
    }

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: session.user.id },
    });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const providerName = process.env.AI_PROVIDER_GENERATE || "gemini";
    const provider = getProvider("generate");
    const result = await provider.generateScene({ prompt, type, ratio, quality });

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
    sceneId = scene.id;

    await prisma.generation.create({
      data: {
        status: permanentUrl ? "completed" : "failed",
        provider: providerName,
        prompt,
        resultUrl: permanentUrl,
        duration: result.duration,
        sceneId: scene.id,
        error: permanentUrl ? null : "No image URL returned from provider",
      },
    });

    return NextResponse.json({
      id: scene.id,
      imageUrl: permanentUrl,
      prompt,
      seed: result.seed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Generate error:", message);

    // Ghi failed generation nếu đã có sceneId
    if (sceneId) {
      await prisma.generation.create({
        data: {
          status: "failed",
          provider: process.env.AI_PROVIDER_GENERATE || "gemini",
          error: message,
          sceneId,
        },
      }).catch(() => {});
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}