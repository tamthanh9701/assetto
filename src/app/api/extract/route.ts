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

    const { sceneId, imageUrl } = await req.json();
    if (!sceneId || !imageUrl) {
      return NextResponse.json({ error: "sceneId and imageUrl required" }, { status: 400 });
    }

    const scene = await prisma.scene.findFirst({
      where: { id: sceneId, project: { userId: session.user.id } },
    });
    if (!scene) return NextResponse.json({ error: "Scene not found" }, { status: 404 });

    // Hướng A: segmentation thật từ provider
    const provider = getProvider("extract");
    const result = await provider.extractLayers({ imageUrl });

    const componentTypes = ["BACKGROUND", "PANEL", "BUTTON", "ICON", "BADGE", "BAR"];
    const outputs = result.components.length > 0 ? result.components : [];

    // Hướng B (fallback): gen từng component với nền trong suốt
    const bgProvider = getProvider("removebg");
    const components = [];

    for (let i = 0; i < componentTypes.length; i++) {
      const label = componentTypes[i].charAt(0) + componentTypes[i].slice(1).toLowerCase();
      const existing = outputs.find(
        (c: any) => c.type === componentTypes[i] || c.name === label
      );
      let pngUrl = existing?.imageUrl || imageUrl;
      let maskUrl = existing?.maskUrl || "";

      // Nếu extraction không trả component riêng, dùng remove-bg làm fallback
      if (!existing) {
        try {
          const removed = await bgProvider.removeBackground({ imageUrl });
          if (removed.imageUrl) {
            pngUrl = removed.imageUrl;
          }
        } catch {
          // fallback: dùng ảnh gốc
        }
      }

      const group = await prisma.componentGroup.create({
        data: { name: label, type: componentTypes[i] as any, order: i, sceneId },
      });

      const asset = await prisma.asset.create({
        data: {
          name: `${label}_${sceneId.slice(0, 6)}`,
          type: "COMPONENT",
          pngUrl,
          maskUrl,
          transparent: true,
          componentGroupId: group.id,
          sceneId,
        },
      });

      components.push({ name: group.name, type: group.type, imageUrl: asset.pngUrl, maskUrl: asset.maskUrl });
    }

    return NextResponse.json({ components });
  } catch (err) {
    console.error("Extract error:", err);
    return NextResponse.json({ error: "Extraction failed" }, { status: 500 });
  }
}