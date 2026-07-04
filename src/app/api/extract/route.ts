import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/ai/registry";
import { persistImage } from "@/lib/storage";

export const maxDuration = 120;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

interface Rgba { r: number; g: number; b: number; a: number }

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
  const bgColor: Rgba = { r: Math.round(corners.reduce((s, c) => s + c.r, 0) / 4), g: Math.round(corners.reduce((s, c) => s + c.g, 0) / 4), b: Math.round(corners.reduce((s, c) => s + c.b, 0) / 4), a: 255 };

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

// Radial split: create core (inside circle) and frame (ring between inner/outer radii)
async function splitRadial(
  cleanPng: Buffer,
  w: number,
  h: number,
  label: string,
  sceneId: string
): Promise<{ coreUrl: string; frameUrl: string; plusUrl?: string }> {
  const sharp = await import("sharp");
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2;
  const innerR = 0.60 * R;
  const outerR = 0.98 * R;

  const raw = await sharp.default(cleanPng).ensureAlpha().raw().toBuffer();
  const pixels = new Uint8Array(raw);
  const bpp = 4;

  // Core: keep pixels inside inner circle, rest alpha=0
  const corePixels = new Uint8Array(raw);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const pi = (y * w + x) * bpp;
      if (dist > innerR) {
        corePixels[pi + 3] = 0;
      }
    }
  }
  const coreBuffer = await sharp.default(corePixels, { raw: { width: w, height: h, channels: 4 } }).trim().png().toBuffer();
  const coreUrl = await persistImage(`data:image/png;base64,${coreBuffer.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_core`);

  // Frame: keep ring between innerR and outerR, rest alpha=0 (punch inner + discard corners)
  const framePixels = new Uint8Array(raw);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const pi = (y * w + x) * bpp;
      if (dist < innerR || dist > outerR) {
        framePixels[pi + 3] = 0;
      }
    }
  }
  const frameBuffer = await sharp.default(framePixels, { raw: { width: w, height: h, channels: 4 } }).trim().png().toBuffer();
  const frameUrl = await persistImage(`data:image/png;base64,${frameBuffer.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_frame`);

  // Plus badge detection: look for red pixels in top-right quadrant
  let plusUrl: string | undefined;
  const qw = Math.round(w * 0.35);
  const qh = Math.round(h * 0.35);
  let hasRed = false;
  for (let y = 0; y < qh && y < h; y++) {
    for (let x = w - qw; x < w; x++) {
      const pi = (y * w + x) * bpp;
      const r = pixels[pi], g = pixels[pi + 1], b = pixels[pi + 2], a = pixels[pi + 3];
      if (a > 128 && r > 180 && g < 100 && b < 100) { hasRed = true; break; }
    }
    if (hasRed) break;
  }
  if (hasRed) {
    // Extract plus badge area from clean crop, chroma-key it
    const plusRaw = await sharp.default(cleanPng)
      .extract({ left: w - qw, top: 0, width: qw, height: qh })
      .ensureAlpha()
      .raw()
      .toBuffer();
    const plusKeyed = chromaKey(plusRaw, qw, qh, 28);
    const plusBuffer = await sharp.default(plusKeyed, { raw: { width: qw, height: qh, channels: 4 } }).trim().png().toBuffer();
    plusUrl = await persistImage(`data:image/png;base64,${plusBuffer.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_plus`);

    // Punch plus badge out of frame
    // Create transparent rectangle over the badge area on the frame
    const punchOut = await sharp.default({
      create: { width: qw, height: qh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();
    const frameFixed = await sharp.default(frameBuffer)
      .composite([{ input: punchOut, left: w - qw, top: 0 }])
      .png()
      .toBuffer();
    const frameFixedUrl = await persistImage(`data:image/png;base64,${frameFixed.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_frame`);
    return { coreUrl, frameUrl: frameFixedUrl, plusUrl };
  }

  return { coreUrl, frameUrl };
}

// AI-guided split: crop inner_icon box from Gemini, punch from frame
async function splitByAI(
  cleanPng: Buffer,
  w: number,
  h: number,
  label: string,
  sceneId: string
): Promise<{ coreUrl?: string; frameUrl?: string; plusUrl?: string }> {
  const sharp = await import("sharp");
  const base64 = cleanPng.toString("base64");
  const SEGMENTATION_MODEL = "gemini-2.5-flash";
  const apiKey = process.env.GEMINI_API_KEY || "";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${SEGMENTATION_MODEL}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: "Return JSON {\"inner_icon\":[y1,x1,y2,x2] or null}. Coords 0-1000. inner_icon = the central symbol/label of this UI element, excluding frame/border." }, { inlineData: { mimeType: "image/png", data: base64 } }] }],
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
  const box = result.inner_icon;
  if (!box || box.length !== 4) return {};

  const [sy1, sx1, sy2, sx2] = box;
  const sl = clamp(Math.round((sx1 / 1000) * w), 0, w - 1);
  const st = clamp(Math.round((sy1 / 1000) * h), 0, h - 1);
  const cw = clamp(Math.round(((sx2 - sx1) / 1000) * w), 1, w - sl);
  const ch = clamp(Math.round(((sy2 - sy1) / 1000) * h), 1, h - st);

  const iconBuffer = await sharp.default(cleanPng).extract({ left: sl, top: st, width: cw, height: ch }).png().toBuffer();
  const coreUrl = await persistImage(`data:image/png;base64,${iconBuffer.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_core`);

  const punchOut = await sharp.default({ create: { width: cw, height: ch, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const frameBuffer = await sharp.default(cleanPng).composite([{ input: punchOut, left: sl, top: st }]).png().toBuffer();
  const frameUrl = await persistImage(`data:image/png;base64,${frameBuffer.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_frame`);

  return { coreUrl, frameUrl };
}

function isRound(w: number, h: number): boolean {
  const ratio = w / h;
  return ratio >= 0.85 && ratio <= 1.18;
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { sceneId, imageUrl } = await req.json();
    if (!sceneId || !imageUrl) return NextResponse.json({ error: "sceneId and imageUrl required" }, { status: 400 });

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

    const CONCURRENCY = 5;
    const results: any[] = [];

    for (let batchStart = 0; batchStart < allElements.length; batchStart += CONCURRENCY) {
      const batch = allElements.slice(batchStart, batchStart + CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(async (seg) => {
          const label = seg.name;
          const type = seg.type;
          const isBg = type === "BACKGROUND";

          if (!seg.box2d) {
            const pngUrl = await persistImage(imageUrl, `comp_${sceneId.slice(0, 6)}_${label}`);
            const group = await getOrCreateGroup(sceneId, type, 0);
            const mainAsset = await prisma.asset.create({ data: { name: `${label}_${sceneId.slice(0, 6)}`, type: group.type as any, pngUrl, transparent: true, componentGroupId: group.id, sceneId } });
            return { name: label, type: group.type, imageUrl: pngUrl, assets: [mainAsset] };
          }

          const [y1, x1, y2, x2] = seg.box2d;
          const left = clamp(Math.round((x1 / 1000) * W), 0, W - 1);
          const top = clamp(Math.round((y1 / 1000) * H), 0, H - 1);
          const cw = clamp(Math.round(((x2 - x1) / 1000) * W), 1, W - left);
          const ch = clamp(Math.round(((y2 - y1) / 1000) * H), 1, H - top);

          let cropBuffer = await sharp.default(imgBuffer).extract({ left, top, width: cw, height: ch }).ensureAlpha().raw().toBuffer();
          cropBuffer = Buffer.from(chromaKey(cropBuffer, cw, ch, 28));
          const cleanPng = await sharp.default(cropBuffer, { raw: { width: cw, height: ch, channels: 4 } }).trim().png().toBuffer();

          const group = await getOrCreateGroup(sceneId, type, batchStart + batch.indexOf(seg));
          const assets: any[] = [];

          // Hybrid: round → radial split, non-round → AI split
          const isRoundElement = isRound(cw, ch) && (type.startsWith("ICON") || type.startsWith("BUTTON") || type.startsWith("BADGE"));

          if (isRoundElement) {
            const sub = await splitRadial(cleanPng, cw, ch, label, sceneId);
            for (const [subType, url] of Object.entries({ core: sub.coreUrl, frame: sub.frameUrl, plus: sub.plusUrl })) {
              if (!url) continue;
              const asset = await prisma.asset.create({ data: { name: `${label}_${sceneId.slice(0, 6)}_${subType}`, type: group.type as any, subType, pngUrl: url, transparent: true, componentGroupId: group.id, sceneId } });
              assets.push(asset);
            }
          } else if (type.startsWith("ICON") || type.startsWith("BUTTON") || type.startsWith("BADGE")) {
            const sub = await splitByAI(cleanPng, cw, ch, label, sceneId);
            for (const [subType, url] of Object.entries({ core: sub.coreUrl, frame: sub.frameUrl, plus: sub.plusUrl })) {
              if (!url) continue;
              const asset = await prisma.asset.create({ data: { name: `${label}_${sceneId.slice(0, 6)}_${subType}`, type: group.type as any, subType, pngUrl: url, transparent: true, componentGroupId: group.id, sceneId } });
              assets.push(asset);
            }
          }

          const mainPngUrl = await persistImage(`data:image/png;base64,${cleanPng.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}`);
          const mainAsset = await prisma.asset.create({ data: { name: `${label}_${sceneId.slice(0, 6)}`, type: group.type as any, pngUrl: mainPngUrl, transparent: true, componentGroupId: group.id, sceneId } });
          assets.push(mainAsset);

          return { name: label, type: group.type, imageUrl: mainPngUrl, assets };
        })
      );

      for (const r of batchResults) {
        if (r.status === "fulfilled") results.push(r.value);
        else console.warn("[extract] batch failed:", r.reason);
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

  let group = await prisma.componentGroup.findFirst({ where: { sceneId, type: groupType as any } });
  if (!group) {
    group = await prisma.componentGroup.create({ data: { name: groupType.charAt(0) + groupType.slice(1).toLowerCase(), type: groupType as any, order, sceneId } });
  }
  return group;
}