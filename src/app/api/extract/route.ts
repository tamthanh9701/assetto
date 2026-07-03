import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/ai/registry";
import { persistImage, persistBase64Image } from "@/lib/storage";

export const maxDuration = 120;

async function extractComponentWithMask(
  imageUrl: string,
  maskUrl: string,
  label: string,
  sceneId: string
): Promise<string> {
  try {
    const sharp = await import("sharp");
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
    const imgBuffer = Buffer.from(await res.arrayBuffer());

    const imgMeta = await sharp.default(imgBuffer).metadata();

    // maskUrl can be a data URL or a URL
    let maskBuffer: Buffer;
    if (maskUrl.startsWith("data:")) {
      const matches = maskUrl.match(/^data:image\/\w+;base64,(.+)$/);
      if (!matches) throw new Error("Invalid mask data URL");
      maskBuffer = Buffer.from(matches[1], "base64");
    } else {
      const maskRes = await fetch(maskUrl);
      if (!maskRes.ok) throw new Error(`Failed to fetch mask: ${maskRes.status}`);
      maskBuffer = Buffer.from(await maskRes.arrayBuffer());
    }

    const extracted = await sharp.default(imgBuffer)
      .composite([
        {
          input: await sharp.default(maskBuffer)
            .resize(imgMeta.width!, imgMeta.height!, { fit: "fill" })
            .grayscale()
            .png()
            .toBuffer(),
          blend: "dest-in",
        },
      ])
      .png()
      .toBuffer();

    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (blobToken) {
      const { put } = await import("@vercel/blob");
      const filename = `comp_${sceneId.slice(0, 6)}_${label}_${Date.now()}.png`;
      const result = await put(filename, extracted, { access: "public" });
      return result.url;
    }

    return `data:image/png;base64,${extracted.toString("base64")}`;
  } catch (e) {
    console.warn(`[extractComponentWithMask] fallback to original for ${label}:`, e);
    return imageUrl;
  }
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

    const componentTypes = ["BACKGROUND", "PANEL", "BUTTON", "ICON", "BADGE", "BAR"];

    // Segmentation via provider (Gemini or Replicate)
    const provider = getProvider("extract");
    const segmentResult = await provider.extractLayers({ imageUrl, componentTypes });

    // Remove background fallback
    const bgProvider = getProvider("removebg");
    let transparentBgUrl = imageUrl;
    try {
      const removed = await bgProvider.removeBackground({ imageUrl });
      if (removed.imageUrl) transparentBgUrl = removed.imageUrl;
    } catch (e) {
      console.warn("[extract] remove-bg fallback failed:", e);
    }

    const components = await Promise.all(
      componentTypes.map(async (type, i) => {
        const label = type.charAt(0) + type.slice(1).toLowerCase();
        const existing = segmentResult.components.find(
          (c) => c.type === type || c.name === label
        );

        let pngUrl: string;
        let maskUrl = existing?.maskUrl || "";

        if (existing?.maskUrl) {
          // Crop from mask
          pngUrl = await extractComponentWithMask(imageUrl, existing.maskUrl, label, sceneId);
        } else {
          // Fallback to remove-bg
          pngUrl = transparentBgUrl;
        }

        const isDataUrl = typeof pngUrl === "string" && pngUrl.startsWith("data:");
        const permanentUrl = isDataUrl
          ? await persistBase64Image(pngUrl, `comp_${sceneId.slice(0, 6)}_${label}`)
          : await persistImage(pngUrl, `comp_${sceneId.slice(0, 6)}_${label}`);

        const permMask = maskUrl
          ? (maskUrl.startsWith("data:")
            ? await persistBase64Image(maskUrl, `mask_${sceneId.slice(0, 6)}_${label}`)
            : await persistImage(maskUrl, `mask_${sceneId.slice(0, 6)}_${label}`))
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
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Extract error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}