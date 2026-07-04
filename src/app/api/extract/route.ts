import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/ai/registry";
import { persistImage } from "@/lib/storage";

export const maxDuration = 120;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function colorDist(a: Rgba, b: Rgba): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function chromaKey(raw: Buffer, w: number, h: number, tolerance: number): Uint8Array {
  const pixels = new Uint8Array(raw);
  const bpp = 4;
  const stride = w * bpp;

  // Estimate background color from corners
  const corners: Rgba[] = [
    { r: pixels[0], g: pixels[1], b: pixels[2], a: pixels[3] },
    { r: pixels[(w - 1) * bpp], g: pixels[(w - 1) * bpp + 1], b: pixels[(w - 1) * bpp + 2], a: pixels[(w - 1) * bpp + 3] },
    { r: pixels[(h - 1) * stride], g: pixels[(h - 1) * stride + 1], b: pixels[(h - 1) * stride + 2], a: pixels[(h - 1) * stride + 3] },
    { r: pixels[(h - 1) * stride + (w - 1) * bpp], g: pixels[(h - 1) * stride + (w - 1) * bpp + 1], b: pixels[(h - 1) * stride + (w - 1) * bpp + 2], a: pixels[(h - 1) * stride + (w - 1) * bpp + 3] },
  ];
  const bgColor: Rgba = {
    r: Math.round(corners.reduce((s, c) => s + c.r, 0) / 4),
    g: Math.round(corners.reduce((s, c) => s + c.g, 0) / 4),
    b: Math.round(corners.reduce((s, c) => s + c.b, 0) / 4),
    a: 255,
  };

  // BFS flood-fill from edge pixels
  const visited = new Uint8Array(w * h);
  const queue: number[] = [];
  const idx = (x: number, y: number) => y * w + x;

  // Push all edge pixels
  for (let x = 0; x < w; x++) {
    queue.push(idx(x, 0), idx(x, h - 1));
  }
  for (let y = 0; y < h; y++) {
    queue.push(idx(0, y), idx(w - 1, y));
  }

  let qi = 0;
  while (qi < queue.length) {
    const i = queue[qi++];
    if (visited[i]) continue;
    visited[i] = 1;

    const pi = i * bpp;
    const px: Rgba = { r: pixels[pi], g: pixels[pi + 1], b: pixels[pi + 2], a: pixels[pi + 3] };
    if (colorDist(px, bgColor) > tolerance) continue;

    // Set alpha to 0
    pixels[pi + 3] = 0;

    const x = i % w;
    const y = Math.floor(i / w);
    if (x > 0) queue.push(i - 1);
    if (x < w - 1) queue.push(i + 1);
    if (y > 0) queue.push(i - w);
    if (y < h - 1) queue.push(i + w);
  }

  return new Uint8Array(pixels);
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

    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`Failed to fetch source image: ${imgRes.status}`);
    const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

    const sharp = await import("sharp");
    const imgMeta = await sharp.default(imgBuffer).metadata();
    const W = imgMeta.width || 1024;
    const H = imgMeta.height || 576;

    const provider = getProvider("extract");
    const segmentResult = await provider.extractLayers({ imageUrl });
    const allElements = segmentResult.components;

    const results = await Promise.allSettled(
      allElements.map(async (seg, i) => {
        const label = seg.name;
        const type = seg.type;
        const isBackground = type === "BACKGROUND";

        let pngUrl: string;

        if (seg.box2d) {
          const [y1, x1, y2, x2] = seg.box2d;
          const left = clamp(Math.round((x1 / 1000) * W), 0, W - 1);
          const top = clamp(Math.round((y1 / 1000) * H), 0, H - 1);
          const width = clamp(Math.round(((x2 - x1) / 1000) * W), 1, W - left);
          const height = clamp(Math.round(((y2 - y1) / 1000) * H), 1, H - top);

          let cropBuffer = await sharp.default(imgBuffer)
            .extract({ left, top, width, height })
            .ensureAlpha()
            .raw()
            .toBuffer();

          // Chroma-key for non-background components
          if (!isBackground) {
            const keyed = chromaKey(cropBuffer, width, height, 28);
            cropBuffer = Buffer.from(keyed);
            cropBuffer = await sharp.default(cropBuffer, { raw: { width, height, channels: 4 } })
              .trim()
              .png()
              .toBuffer();
          } else {
            cropBuffer = await sharp.default(cropBuffer, { raw: { width, height, channels: 4 } })
              .png()
              .toBuffer();
          }

          pngUrl = await persistImage(
            `data:image/png;base64,${cropBuffer.toString("base64")}`,
            `comp_${sceneId.slice(0, 6)}_${label}`
          );
        } else {
          pngUrl = await persistImage(imageUrl, `comp_${sceneId.slice(0, 6)}_${label}`);
        }

        // Group by type
        const groupType = type === "BACKGROUND" ? "BACKGROUND"
          : type === "PANEL" ? "PANEL"
          : type.startsWith("BUTTON") ? "BUTTON"
          : type.startsWith("ICON") ? "ICON"
          : type.startsWith("BAR") ? "BAR"
          : type.startsWith("BADGE") ? "BADGE"
          : "CUSTOM";

        let group = await prisma.componentGroup.findFirst({
          where: { sceneId, type: groupType as any },
        });

        if (!group) {
          group = await prisma.componentGroup.create({
            data: { name: groupType.charAt(0) + groupType.slice(1).toLowerCase(), type: groupType as any, order: i, sceneId },
          });
        }

        const asset = await prisma.asset.create({
          data: {
            name: `${label}_${sceneId.slice(0, 6)}`,
            type: groupType as any,
            pngUrl,
            transparent: !isBackground,
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

    console.log(`[extract] ${components.length} components extracted`);

    return NextResponse.json({ components });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Extract error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}