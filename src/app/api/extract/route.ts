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
  r: number; g: number; b: number; a: number;
}

function colorDist(a: Rgba, b: Rgba): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function chromaKey(raw: Buffer, w: number, h: number, tolerance: number): Buffer {
  const pixels = new Uint8Array(raw);
  const bpp = 4;
  const stride = w * bpp;

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

  const visited = new Uint8Array(w * h);
  const queue: number[] = [];
  const idx = (x: number, y: number) => y * w + x;

  for (let x = 0; x < w; x++) { queue.push(idx(x, 0), idx(x, h - 1)); }
  for (let y = 0; y < h; y++) { queue.push(idx(0, y), idx(w - 1, y)); }

  let qi = 0;
  while (qi < queue.length) {
    const i = queue[qi++];
    if (visited[i]) continue;
    visited[i] = 1;
    const pi = i * bpp;
    const px: Rgba = { r: pixels[pi], g: pixels[pi + 1], b: pixels[pi + 2], a: pixels[pi + 3] };
    if (colorDist(px, bgColor) > tolerance) continue;
    pixels[pi + 3] = 0;
    const x = i % w;
    const y = Math.floor(i / w);
    if (x > 0) queue.push(i - 1);
    if (x < w - 1) queue.push(i + 1);
    if (y > 0) queue.push(i - w);
    if (y < h - 1) queue.push(i + w);
  }
  return Buffer.from(pixels);
}

async function segmentSubElement(
  cropBuffer: Buffer,
  label: string
): Promise<{ innerIcon?: [number, number, number, number]; plusBadge?: [number, number, number, number] }> {
  try {
    const base64 = cropBuffer.toString("base64");
    const SEGMENTATION_MODEL = "gemini-2.5-flash";
    const apiKey = process.env.GEMINI_API_KEY || "";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${SEGMENTATION_MODEL}:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: "In this UI element image, return JSON: {\"inner_icon\":[y1,x1,y2,x2], \"plus_badge\":[y1,x1,y2,x2] or null}. Coords 0-1000 relative to THIS image. inner_icon = the central symbol only, excluding the round frame/border." },
              { inlineData: { mimeType: "image/png", data: base64 } },
            ],
          },
        ],
        generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: 0 }, responseMimeType: "application/json" },
      }),
    });

    if (!res.ok) return {};
    const data = await res.json();
    const textPart = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.text);
    if (!textPart) return {};

    const objMatch = textPart.text.trim().match(/\{[\s\S]*\}/);
    if (!objMatch) return {};
    const result = JSON.parse(objMatch[0]);
    return {
      innerIcon: result.inner_icon?.length === 4 ? result.inner_icon : undefined,
      plusBadge: result.plus_badge?.length === 4 ? result.plus_badge : undefined,
    };
  } catch {
    return {};
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

    // Limit concurrent sub-segmentation calls
    const CONCURRENCY = 5;
    const results: any[] = [];

    for (let batchStart = 0; batchStart < allElements.length; batchStart += CONCURRENCY) {
      const batch = allElements.slice(batchStart, batchStart + CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(async (seg) => {
          const label = seg.name;
          const type = seg.type;
          const isBackground = type === "BACKGROUND";
          const needsSubSeg = type.startsWith("ICON") || type.startsWith("BUTTON") || type.startsWith("BADGE");

          if (!seg.box2d) {
            const pngUrl = await persistImage(imageUrl, `comp_${sceneId.slice(0, 6)}_${label}`);
            const group = await getOrCreateGroup(sceneId, type, 0);
            const asset = await prisma.asset.create({
              data: { name: `${label}_${sceneId.slice(0, 6)}`, type: group.type as any, pngUrl, transparent: true, componentGroupId: group.id, sceneId },
            });
            return { name: label, type: group.type, imageUrl: asset.pngUrl, assets: [asset] };
          }

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

          // Chroma-key
          cropBuffer = Buffer.from(chromaKey(cropBuffer, width, height, 28));
          const cleanPng = await sharp.default(cropBuffer, { raw: { width, height, channels: 4 } })
            .trim()
            .png()
            .toBuffer();

          const group = await getOrCreateGroup(sceneId, type, batchStart + batch.indexOf(seg));

          // Sub-segmentation for icons/buttons/badges
          let assets: any[] = [];
          if (needsSubSeg) {
            const sub = await segmentSubElement(cleanPng, label);
            const subResults: any[] = [];

            if (sub.innerIcon) {
              const [sy1, sx1, sy2, sx2] = sub.innerIcon;
              const sw = Math.round(((sx2 - sx1) / 1000) * width);
              const sh = Math.round(((sy2 - sy1) / 1000) * height);
              const sl = clamp(Math.round((sx1 / 1000) * width), 0, width - 1);
              const st = clamp(Math.round((sy1 / 1000) * height), 0, height - 1);
              const cw = clamp(sw, 1, width - sl);
              const ch = clamp(sh, 1, height - st);

              const iconBuffer = await sharp.default(cleanPng)
                .extract({ left: sl, top: st, width: cw, height: ch })
                .png()
                .toBuffer();

              const iconUrl = await persistImage(`data:image/png;base64,${iconBuffer.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_core`);
              subResults.push({ subType: "core", pngUrl: iconUrl });
            }

            // Frame: punch out inner_icon area
            if (sub.innerIcon) {
              const [sy1, sx1, sy2, sx2] = sub.innerIcon;
              const sw = Math.round(((sx2 - sx1) / 1000) * width);
              const sh = Math.round(((sy2 - sy1) / 1000) * height);
              const sl = clamp(Math.round((sx1 / 1000) * width), 0, width - 1);
              const st = clamp(Math.round((sy1 / 1000) * height), 0, height - 1);
              const cw = clamp(sw, 1, width - sl);
              const ch = clamp(sh, 1, height - st);

              // Create a black rectangle to punch out
              const punchOut = await sharp.default({
                create: { width: cw, height: ch, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
              }).png().toBuffer();

              const frameBuffer = await sharp.default(cleanPng)
                .composite([{ input: punchOut, left: sl, top: st }])
                .png()
                .toBuffer();

              const frameUrl = await persistImage(`data:image/png;base64,${frameBuffer.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_frame`);
              subResults.push({ subType: "frame", pngUrl: frameUrl });
            }

            if (sub.plusBadge) {
              const [py1, px1, py2, px2] = sub.plusBadge;
              const pw = Math.round(((px2 - px1) / 1000) * width);
              const ph = Math.round(((py2 - py1) / 1000) * height);
              const pl = clamp(Math.round((px1 / 1000) * width), 0, width - 1);
              const pt = clamp(Math.round((py1 / 1000) * height), 0, height - 1);
              const cw = clamp(pw, 1, width - pl);
              const ch = clamp(ph, 1, height - pt);

              const badgeBuffer = await sharp.default(cleanPng)
                .extract({ left: pl, top: pt, width: cw, height: ch })
                .png()
                .toBuffer();

              const badgeUrl = await persistImage(`data:image/png;base64,${badgeBuffer.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_plus`);
              subResults.push({ subType: "plus", pngUrl: badgeUrl });
            }

            // Create assets for sub-results
            for (const sr of subResults) {
              const asset = await prisma.asset.create({
                data: {
                  name: `${label}_${sceneId.slice(0, 6)}_${sr.subType}`,
                  type: group.type as any,
                  subType: sr.subType,
                  pngUrl: sr.pngUrl,
                  transparent: true,
                  componentGroupId: group.id,
                  sceneId,
                },
              });
              assets.push(asset);
            }
          }

          // Create main asset (the whole crop)
          const mainPngUrl = await persistImage(`data:image/png;base64,${cleanPng.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}`);
          const mainAsset = await prisma.asset.create({
            data: {
              name: `${label}_${sceneId.slice(0, 6)}`,
              type: group.type as any,
              pngUrl: mainPngUrl,
              transparent: true,
              componentGroupId: group.id,
              sceneId,
            },
          });
          assets.push(mainAsset);

          return { name: label, type: group.type, imageUrl: mainPngUrl, assets };
        })
      );

      for (const r of batchResults) {
        if (r.status === "fulfilled") results.push(r.value);
        else console.warn("[extract] batch element failed:", r.reason);
      }
    }

    console.log(`[extract] ${results.length} components extracted`);

    return NextResponse.json({ components: results.map((r) => ({ name: r.name, type: r.type, imageUrl: r.imageUrl })) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Extract error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function getOrCreateGroup(sceneId: string, type: string, order: number) {
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
      data: { name: groupType.charAt(0) + groupType.slice(1).toLowerCase(), type: groupType as any, order, sceneId },
    });
  }

  return group;
}