import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const job = await prisma.job.findFirst({
    where: { id, userId: session.user.id },
  });

  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const assets = job.sceneId
    ? await prisma.asset.findMany({
        where: { sceneId: job.sceneId, scene: { project: { userId: session.user.id } } },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          name: true,
          type: true,
          subType: true,
          pngUrl: true,
          transparent: true,
          width: true,
          height: true,
          componentGroup: { select: { id: true, name: true, type: true } },
        },
      })
    : [];

  return NextResponse.json({
    id: job.id,
    sceneId: job.sceneId,
    status: job.status,
    progress: job.progress,
    resultZipUrl: job.resultZipUrl,
    error: job.error,
    assets,
  });
}
