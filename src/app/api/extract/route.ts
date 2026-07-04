import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Client } from "@upstash/qstash";

export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { sceneId, imageUrl } = await req.json();
    if (!sceneId || !imageUrl) return NextResponse.json({ error: "sceneId and imageUrl required" }, { status: 400 });

    const scene = await prisma.scene.findFirst({
      where: { id: sceneId, project: { userId: session.user.id } },
    });
    if (!scene) return NextResponse.json({ error: "Scene not found" }, { status: 404 });

    const job = await prisma.job.create({
      data: {
        userId: session.user.id,
        sceneId,
        type: "extract",
        status: "pending",
        progress: 0,
        metadata: { imageUrl },
      },
    });

    // Publish to QStash — guaranteed delivery, auto-retry on failure
    const q = new Client({ token: process.env.QSTASH_TOKEN || "" });
    const workerUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/extract/worker`;

    await q.publishJSON({
      url: workerUrl,
      body: { jobId: job.id },
      // Retry up to 3 times with exponential backoff
      retries: 3,
    });

    return NextResponse.json({ jobId: job.id, status: "pending" }, { status: 202 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Extract error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}