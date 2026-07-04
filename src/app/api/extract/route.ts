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

async function segmentIconMask(cleanPng: Buffer, w: number, h: number): Promise<Buffer | null> {
  try {
    const sharp = await import("sharp");
    const base64 = cleanPng.toString("base64");
    const apiKey = process.env.GEMINI_API_KEY || "";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: "Return a segmentation mask (base64 PNG) covering ONLY the central icon symbol, EXCLUDING the round gold frame/border and background. JSON: {\"mask\":\"<base64 PNG>\", \"box_2d\":[y1,x1,y2,x2]}. Coordinates 0-1000. Return ONLY the JSON." },
          { inlineData: { mimeType: "image/png", data: base64 } },
        ]}],
        generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: 0 }, responseMimeType: "application/json" },
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const textPart = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.text);
    if (!textPart) return null;

    const objMatch = textPart.text.trim().match(/\{[\s\S]*\}/);
    if (!objMatch) return null;
    const result = JSON.parse(objMatch[0]);
    if (!result.mask) return null;

    let maskB64 = result.mask;
    if (maskB64.includes("base64,")) maskB64 = maskB64.split("base64,")[1];

    const maskBuffer = Buffer.from(maskB64, "base64");
    const resized = await sharp.default(maskBuffer)
      .resize(w, h, { fit: "fill" })
      .grayscale()
      .threshold(128)
      .raw()
      .toBuffer();

    return Buffer.from(resized);
  } catch {
    return null;
  }
}

async function radialMask(w: number, h: number): Promise<Buffer> {
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2;
  const innerR = 0.58 * R;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      if (Math.sqrt(dx * dx + dy * dy) < innerR) mask[y * w + x] = 255;
    }
  }
  return Buffer.from(mask);
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { sceneId, imageUrl } = await req.json();
    if (!sceneId || !imageUrl) return NextResponse.json({ error: "sceneId and imageUrl required" }, { status: 400 });

    const scene = await prisma.scene.findFirst({ where: { id: sceneId, project: { userId: session.user.id } } });
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
          const isIconButton = type.startsWith("ICON") || type.startsWith("BUTTON") || type.startsWith("BADGE");

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
          const trimMeta = await sharp.default(cleanPng).metadata();
          const tw = trimMeta.width || cw;
          const th = trimMeta.height || ch;

          const group = await getOrCreateGroup(sceneId, type, batchStart + batch.indexOf(seg));
          const assets: any[] = [];

          if (isIconButton) {
            // Per-pixel mask via Gemini segmentation
            const mask = await segmentIconMask(cleanPng, tw, th);
            const isAI = mask !== null;
            const alphaMask = mask || (await radialMask(tw, th));

            if (!isAI) console.warn(`[extract] ${label}: mask from AI failed, fallback to radial`);

            // Core: apply mask as alpha
            const rawPixels = await sharp.default(cleanPng).ensureAlpha().raw().toBuffer();
            const pixels = new Uint8Array(rawPixels);
            const bpp = 4;
            let coreTransparent = 0;
            let coreTotal = 0;
            for (let y = 0; y < th; y++) {
              for (let x = 0; x < tw; x++) {
                const pi = (y * tw + x) * bpp;
                const mi = y * tw + x;
                if (alphaMask[mi] < 128) {
                  pixels[pi + 3] = 0;
                  coreTransparent++;
                }
                coreTotal++;
              }
            }
            const coreBuffer = await sharp.default(pixels, { raw: { width: tw, height: th, channels: 4 } }).trim().png().toBuffer();
            const coreUrl = await persistImage(`data:image/png;base64,${coreBuffer.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_core`);

            // Frame: punch out mask pixels
            const framePixels = new Uint8Array(rawPixels);
            let frameTransparent = 0;
            let frameTotal = 0;
            for (let y = 0; y < th; y++) {
              for (let x = 0; x < tw; x++) {
                const pi = (y * tw + x) * bpp;
                const mi = y * tw + x;
                if (alphaMask[mi] >= 128) {
                  framePixels[pi + 3] = 0;
                  frameTransparent++;
                }
                frameTotal++;
              }
            }
            const frameBuffer = await sharp.default(framePixels, { raw: { width: tw, height: th, channels: 4 } }).trim().png().toBuffer();
            const frameUrl = await persistImage(`data:image/png;base64,${frameBuffer.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_frame`);

            const corePct = ((coreTransparent / coreTotal) * 100).toFixed(1);
            const framePct = ((frameTransparent / frameTotal) * 100).toFixed(1);
            console.log(`[extract] ${label}: core_transparent=${corePct}% frame_transparent=${framePct}% method=${isAI ? "AI" : "radial"}`);

            const coreAsset = await prisma.asset.create({ data: { name: `${label}_${sceneId.slice(0, 6)}_core`, type: group.type as any, subType: "core", pngUrl: coreUrl, transparent: true, componentGroupId: group.id, sceneId } });
            const frameAsset = await prisma.asset.create({ data: { name: `${label}_${sceneId.slice(0, 6)}_frame`, type: group.type as any, subType: "frame", pngUrl: frameUrl, transparent: true, componentGroupId: group.id, sceneId } });
            assets.push(coreAsset, frameAsset);
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