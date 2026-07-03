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

    const { sceneId, imageUrl } = await req.json();
    if (!sceneId || !imageUrl) {
      return NextResponse.json({ error: "sceneId and imageUrl required" }, { status: 400 });
    }

    const scene = await prisma.scene.findFirst({
      where: { id: sceneId, project: { userId: session.user.id } },
    });
    if (!scene) return NextResponse.json({ error: "Scene not found" }, { status: 404 });

    const componentTypes = ["BACKGROUND", "PANEL", "BUTTON", "ICON", "BADGE", "BAR"];

    // Hướng A: segmentation thật
    const provider = getProvider("extract");
    const segmentResult = await provider.extractLayers({ imageUrl, componentTypes });

    // Hướng B: gen prompt riêng cho từng component với nền trong suốt
    const bgProvider = getProvider("removebg");

    // Chạy song song cả 6 component
    const components = await Promise.all(
      componentTypes.map(async (type, i) => {
        const label = type.charAt(0) + type.slice(1).toLowerCase();
        const existing = segmentResult.components.find(
          (c) => c.type === type || c.name === label
        );

        // Nếu có mask từ SAM, dùng ảnh gốc + remove-bg để tách nền
        let pngUrl = existing?.imageUrl || imageUrl;
        let maskUrl = existing?.maskUrl || "";

        if (!existing) {
          try {
            const removed = await bgProvider.removeBackground({ imageUrl });
            if (removed.imageUrl) pngUrl = removed.imageUrl;
          } catch {
            // fallback: dùng ảnh gốc
          }
        }

        // Persist ảnh component
        const isDataUrl = pngUrl.startsWith("data:");
        const permanentUrl = isDataUrl
          ? await persistBase64Image(pngUrl, `comp_${sceneId.slice(0, 6)}_${label}`)
          : await persistImage(pngUrl, `comp_${sceneId.slice(0, 6)}_${label}`);

        const permMask = maskUrl
          ? await persistImage(maskUrl, `mask_${sceneId.slice(0, 6)}_${label}`)
          : "";

        const group = await prisma.componentGroup.create({
          data: { name: label, type: type as any, order: i, sceneId },
        });

        const asset = await prisma.asset.create({
          data: {
            name: `${label}_${sceneId.slice(0, 6)}`,
            type: "COMPONENT",
            pngUrl: permanentUrl,
            maskUrl: permMask,
            transparent: true,
            componentGroupId: group.id,
            sceneId,
          },
        });

        return { name: group.name, type: group.type, imageUrl: asset.pngUrl, maskUrl: asset.maskUrl };
      })
    );

    return NextResponse.json({ components });
  } catch (err) {
    console.error("Extract error:", err);
    return NextResponse.json({ error: "Extraction failed" }, { status: 500 });
  }
}