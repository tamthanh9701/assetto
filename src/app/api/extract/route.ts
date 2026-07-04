import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/ai/registry";
import { persistImage } from "@/lib/storage";

export const maxDuration = 120;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

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

    // Fetch source image
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`Failed to fetch source image: ${imgRes.status}`);
    const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

    const sharp = await import("sharp");
    const imgMeta = await sharp.default(imgBuffer).metadata();
    const W = imgMeta.width || 1024;
    const H = imgMeta.height || 576;

    const componentTypes = ["BACKGROUND", "PANEL", "BUTTON", "ICON", "BADGE", "BAR"];

    // 1 call segmentation — box only
    const provider = getProvider("extract");
    const segmentResult = await provider.extractLayers({ imageUrl, componentTypes });

    // Crop each component by box
    const results = await Promise.allSettled(
      componentTypes.map(async (type, i) => {
        const label = type.charAt(0) + type.slice(1).toLowerCase();
        const seg = segmentResult.components.find(
          (c) => c.type === type || c.name === label
        );

        let pngUrl: string;

        if (seg?.box2d) {
          const [y1, x1, y2, x2] = seg.box2d;
          const left = clamp(Math.round((x1 / 1000) * W), 0, W - 1);
          const top = clamp(Math.round((y1 / 1000) * H), 0, H - 1);
          const width = clamp(Math.round(((x2 - x1) / 1000) * W), 1, W - left);
          const height = clamp(Math.round(((y2 - y1) / 1000) * H), 1, H - top);

          const crop = await sharp.default(imgBuffer)
            .extract({ left, top, width, height })
            .png()
            .toBuffer();

          pngUrl = await persistImage(
            `data:image/png;base64,${crop.toString("base64")}`,
            `comp_${sceneId.slice(0, 6)}_${label}`
          );
        } else {
          // No box found — crop full image
          pngUrl = await persistImage(imageUrl, `comp_${sceneId.slice(0, 6)}_${label}`);
        }

        const group = await prisma.componentGroup.create({
          data: { name: label, type: type as any, order: i, sceneId },
        });

        const asset = await prisma.asset.create({
          data: {
            name: `${label}_${sceneId.slice(0, 6)}`,
            type: "COMPONENT",
            pngUrl,
            transparent: false,
            componentGroupId: group.id,
            sceneId,
          },
        });

        return { name: group.name, type: group.type, imageUrl: asset.pngUrl };
      })
    );

    const components = results
      .filter((r) => r.status === "fulfilled")
      .map((r: any) => r.value);

    console.log(`[extract] ${components.length}/${componentTypes.length} components extracted`);

    return NextResponse.json({ components });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Extract error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}