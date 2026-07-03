import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/ai/registry";
import { persistImage } from "@/lib/storage";
import sharp from "sharp";

export const maxDuration = 120;

async function fetchImageBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

async function extractComponentWithMask(
  imageUrl: string,
  maskUrl: string,
  label: string,
  sceneId: string
): Promise<string> {
  try {
    const [imgBuffer, maskBuffer] = await Promise.all([
      fetchImageBuffer(imageUrl),
      fetchImageBuffer(maskUrl),
    ]);

    // Resize mask to match image dimensions
    const imgMeta = await sharp(imgBuffer).metadata();
    const maskResized = await sharp(maskBuffer)
      .resize(imgMeta.width, imgMeta.height, { fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer();

    // Apply mask as alpha channel: composite the original image
    // over a transparent background using the mask as alpha
    const extracted = await sharp(imgBuffer)
      .composite([
        {
          input: await sharp(maskBuffer)
            .resize(imgMeta.width, imgMeta.height, { fit: "fill" })
            .grayscale()
            .png()
            .toBuffer(),
          blend: "dest-in",
        },
      ])
      .png()
      .toBuffer();

    // Persist the extracted PNG
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (blobToken) {
      const { put } = await import("@vercel/blob");
      const filename = `comp_${sceneId.slice(0, 6)}_${label}_${Date.now()}.png`;
      const result = await put(filename, extracted, { access: "public" });
      return result.url;
    }

    // No blob — skip extraction, return original image
    return imageUrl;
  } catch {
    // Fallback: return original image
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

    // Hướng A: segmentation thật bằng SAM
    const provider = getProvider("extract");
    const segmentResult = await provider.extractLayers({ imageUrl, componentTypes });

    // Hướng B: remove-bg fallback
    const bgProvider = getProvider("removebg");
    const removedBg = await bgProvider.removeBackground({ imageUrl });
    const transparentBgUrl = removedBg.imageUrl || imageUrl;

    // Chạy song song cả 6 component, dùng mask SAM để crop từng vùng
    const components = await Promise.all(
      componentTypes.map(async (type, i) => {
        const label = type.charAt(0) + type.slice(1).toLowerCase();
        const existing = segmentResult.components.find(
          (c) => c.type === type || c.name === label
        );

        let pngUrl: string;
        let maskUrl = existing?.maskUrl || "";

        if (existing?.maskUrl) {
          // Có mask SAM — crop component thực sự từ ảnh gốc
          pngUrl = await extractComponentWithMask(imageUrl, existing.maskUrl, label, sceneId);
        } else {
          // Không có mask — dùng remove-bg làm fallback
          pngUrl = transparentBgUrl;
        }

        const permanetUrl = await persistImage(pngUrl, `comp_${sceneId.slice(0, 6)}_${label}`);
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
            pngUrl: permanetUrl,
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