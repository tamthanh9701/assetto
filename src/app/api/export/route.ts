import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const sceneId = searchParams.get("sceneId");
    const groupId = searchParams.get("groupId");
    const assetId = searchParams.get("assetId");

    if (assetId) {
      const asset = await prisma.asset.findFirst({
        where: { id: assetId, scene: { project: { userId: session.user.id } } },
      });
      if (!asset?.pngUrl) return NextResponse.json({ error: "Not found" }, { status: 404 });
      const imgRes = await fetch(asset.pngUrl);
      const imgBuffer = await imgRes.arrayBuffer();
      return new NextResponse(imgBuffer, {
        headers: {
          "Content-Type": "image/png",
          "Content-Disposition": `attachment; filename="${asset.name}.png"`,
        },
      });
    }

    if (groupId) {
      const assets = await prisma.asset.findMany({
        where: { componentGroupId: groupId, scene: { project: { userId: session.user.id } } },
      });
      return NextResponse.json({ assets });
    }

    if (sceneId) {
      const assets = await prisma.asset.findMany({
        where: { sceneId, scene: { project: { userId: session.user.id } } },
        include: { componentGroup: true },
      });
      return NextResponse.json({ assets });
    }

    return NextResponse.json({ error: "Provide assetId, groupId, or sceneId" }, { status: 400 });
  } catch (err) {
    console.error("Export error:", err);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}