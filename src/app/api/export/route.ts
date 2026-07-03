import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const maxDuration = 60;

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
    const format = searchParams.get("format") || "single";

    if (assetId && format === "single") {
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

    // ZIP export cho group hoặc scene
    if ((groupId || sceneId) && format === "zip") {
      const where = groupId
        ? { componentGroupId: groupId, scene: { project: { userId: session.user.id } } }
        : { sceneId, scene: { project: { userId: session.user.id } } };

      const assets = await prisma.asset.findMany({ where });
      if (assets.length === 0) return NextResponse.json({ error: "No assets found" }, { status: 404 });

      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();

      await Promise.all(
        assets.map(async (asset) => {
          if (!asset.pngUrl) return;
          try {
            const res = await fetch(asset.pngUrl);
            const buffer = await res.arrayBuffer();
            zip.file(`${asset.name}.png`, buffer);
          } catch {
            // skip failed downloads
          }
        })
      );

      const zipBuffer = await zip.generateAsync({ type: "uint8array" });
      const filename = groupId ? `group_${groupId.slice(0, 8)}` : `scene_${sceneId?.slice(0, 8)}`;
      return new NextResponse(Buffer.from(zipBuffer), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${filename}.zip"`,
        },
      });
    }

    // JSON list
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