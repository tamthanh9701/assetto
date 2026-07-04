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

function morphologyOpen(src: Uint8Array, w: number, h: number, ksize: number): Uint8Array {
  const er = erode(src, w, h, ksize);
  return dilate(er, w, h, ksize);
}

function morphologyClose(src: Uint8Array, w: number, h: number, ksize: number): Uint8Array {
  const di = dilate(src, w, h, ksize);
  return erode(di, w, h, ksize);
}

function dilate(src: Uint8Array, w: number, h: number, ksize: number): Uint8Array {
  const dst = new Uint8Array(w * h);
  const half = Math.floor(ksize / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let max = 0;
      for (let ky = -half; ky <= half; ky++) {
        for (let kx = -half; kx <= half; kx++) {
          const px = x + kx, py = y + ky;
          if (px >= 0 && px < w && py >= 0 && py < h) {
            if (src[py * w + px] > max) max = src[py * w + px];
          }
        }
      }
      dst[y * w + x] = max;
    }
  }
  return dst;
}

function erode(src: Uint8Array, w: number, h: number, ksize: number): Uint8Array {
  const dst = new Uint8Array(w * h);
  const half = Math.floor(ksize / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let min = 255;
      for (let ky = -half; ky <= half; ky++) {
        for (let kx = -half; kx <= half; kx++) {
          const px = x + kx, py = y + ky;
          if (px >= 0 && px < w && py >= 0 && py < h) {
            if (src[py * w + px] < min) min = src[py * w + px];
          }
        }
      }
      dst[y * w + x] = min;
    }
  }
  return dst;
}

function connectedComponents(src: Uint8Array, w: number, h: number, threshold: number): Int32Array {
  const labels = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) labels[i] = src[i] >= threshold ? -2 : -1;

  let nextLabel = 0;
  const stack: number[] = [];

  for (let i = 0; i < w * h; i++) {
    if (labels[i] !== -2) continue;
    labels[i] = nextLabel;
    stack.push(i);
    while (stack.length) {
      const ci = stack.pop()!;
      const x = ci % w, y = Math.floor(ci / w);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        if (labels[ni] === -2) {
          labels[ni] = nextLabel;
          stack.push(ni);
        }
      }
    }
    nextLabel++;
  }

  return labels;
}

// Local image processing to split icon from ring frame (NO Gemini call)
// Returns iconMask, frameMask, plusBadgeUrl (if detected)
function splitLocal(rawPng: Buffer, w: number, h: number, isRound: boolean):
  { iconMask: Uint8Array; frameMask: Uint8Array; plusBadgeMask: Uint8Array | null } {
  const src = new Uint8Array(rawPng);
  const bpp = 4;
  const opaque = new Uint8Array(w * h);
  const rArr = new Uint8Array(w * h);
  const gArr = new Uint8Array(w * h);
  const bArr = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pi = (y * w + x) * bpp;
      const a = src[pi + 3];
      opaque[y * w + x] = a > 100 ? 255 : 0;
      rArr[y * w + x] = src[pi];
      gArr[y * w + x] = src[pi + 1];
      bArr[y * w + x] = src[pi + 2];
    }
  }

  // Detect plus badge: red pixels in top-right quadrant → set alpha=0 there, return mask
  const qw = Math.round(w * 0.35);
  const qh = Math.round(h * 0.35);
  let plusBadgeMask: Uint8Array | null = null;
  let hasRed = false;
  for (let y = 0; y < qh && y < h; y++) {
    for (let x = w - qw; x < w; x++) {
      const pi = (y * w + x) * bpp;
      if (src[pi + 3] > 128 && src[pi] > 180 && src[pi + 1] < 100 && src[pi + 2] < 100) {
        hasRed = true; break;
      }
    }
    if (hasRed) break;
  }
  if (hasRed) {
    plusBadgeMask = new Uint8Array(w * h);
    // Set alpha=0 for badge area in source copy
    for (let y = 0; y < qh && y < h; y++) {
      for (let x = w - qw; x < w; x++) {
        const i = y * w + x;
        const pi = i * bpp;
        if (src[pi + 3] > 128 && src[pi] > 180 && src[pi + 1] < 100 && src[pi + 2] < 100) {
          plusBadgeMask[i] = 255;
          // Remove from opaque to avoid affecting icon/frame
          opaque[i] = 0;
        }
      }
    }
  }

  const cx = w / 2;
  const cy = h / 2;
  const Rmax = Math.min(w, h) / 2;
  const dist = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      dist[y * w + x] = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    }
  }

  // For non-round icons, use ellipse: scale x-distance by aspect ratio
  const aspect = w / h;
  const invAspect = h / w;
  const distEllipse = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) * (isRound ? 1 : invAspect);
      const dy = (y - cy) * (isRound ? 1 : aspect);
      distEllipse[y * w + x] = Math.sqrt(dx * dx + dy * dy);
    }
  }
  const useDist = isRound ? dist : distEllipse;
  const Rused = isRound ? Rmax : (Math.min(w, h) / 2) * Math.max(aspect, invAspect);

  // Estimate ring color: median RGB of opaque pixels within 0.80-0.99*Rused
  const ringSamples: Rgba[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = useDist[i];
      if (opaque[i] > 0 && d >= 0.80 * Rused && d <= 0.99 * Rused) {
        ringSamples.push({ r: rArr[i], g: gArr[i], b: bArr[i], a: 255 });
      }
    }
  }
  let ringColor: Rgba = { r: 200, g: 180, b: 100, a: 255 };
  if (ringSamples.length > 0) {
    ringSamples.sort((a, b) => a.r - b.r);
    const mid = Math.floor(ringSamples.length / 2);
    const midV = Math.max(0, mid - Math.floor(ringSamples.length * 0.1));
    const midVV = Math.min(ringSamples.length, mid + Math.floor(ringSamples.length * 0.1));
    const window = ringSamples.slice(midV, midVV);
    ringColor = {
      r: Math.round(window.reduce((s, c) => s + c.r, 0) / window.length),
      g: Math.round(window.reduce((s, c) => s + c.g, 0) / window.length),
      b: Math.round(window.reduce((s, c) => s + c.b, 0) / window.length),
      a: 255,
    };
  }

  // is_ring: use 0.55*Rused for non-round (more aggressive)
  const ringThreshold = isRound ? 0.60 : 0.55;
  const isRing = new Uint8Array(w * h);
  const iconCandidate = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (opaque[i] > 0 && useDist[i] > ringThreshold * Rused) {
      const d = colorDist({ r: rArr[i], g: gArr[i], b: bArr[i], a: 255 }, ringColor);
      isRing[i] = d < 75 ? 255 : 0;
      iconCandidate[i] = d < 75 ? 0 : 255;
    } else if (opaque[i] > 0) {
      iconCandidate[i] = 255;
    }
  }

  // Morphological OPEN(3)
  const opened = morphologyOpen(iconCandidate, w, h, 3);

  // Connected components → find component containing center
  const labels = connectedComponents(opened, w, h, 128);
  const cxInt = Math.round(cx);
  const cyInt = Math.round(cy);
  const centerLabel = labels[cyInt * w + cxInt];

  const centerMask = new Uint8Array(w * h);
  if (centerLabel >= 0) {
    for (let i = 0; i < w * h; i++) {
      centerMask[i] = (labels[i] === centerLabel) ? 255 : 0;
    }
  } else {
    for (let i = 0; i < w * h; i++) centerMask[i] = opened[i];
  }

  const closed = morphologyClose(centerMask, w, h, 7);
  const iconMask = dilate(closed, w, h, 3);

  // Frame: keep opaque pixels NOT in iconMask (and not in badge)
  const frameMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    frameMask[i] = (opaque[i] > 0 && iconMask[i] === 0) ? 255 : 0;
  }

  return { iconMask, frameMask, plusBadgeMask };
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
          const isIcon = (type.startsWith("ICON") || type.startsWith("BUTTON") || type.startsWith("BADGE"));
          const isRound = isIcon && (() => {
            if (!seg.box2d) return false;
            const [_y1, _x1, _y2, _x2] = seg.box2d;
            const bw = (_x2 - _x1), bh = (_y2 - _y1);
            if (bw <= 0 || bh <= 0) return false;
            const r = bw / bh;
            return r >= 0.85 && r <= 1.18;
          })();
          const shouldSplit = isIcon && seg.box2d !== undefined;

          if (!seg.box2d) {
            console.warn(`[extract] ${label}: no box2d, skipping split`);
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

          if (shouldSplit) {
            // Fully local processing: NO Gemini call
            const rawPixels = await sharp.default(cleanPng).ensureAlpha().raw().toBuffer();
            const { iconMask, frameMask, plusBadgeMask } = splitLocal(rawPixels, tw, th, isRound);
            const bpp = 4;

            // Full transparency for verification
            let fullOpaque = 0;
            for (let i = 0; i < tw * th; i++) {
              if (rawPixels[i * bpp + 3] > 100) fullOpaque++;
            }
            const fullPct = ((tw * th - fullOpaque) / (tw * th) * 100).toFixed(1);

            // Icon: apply iconMask as alpha
            const iconPixels = new Uint8Array(rawPixels);
            let iconOpaque = 0;
            for (let y = 0; y < th; y++) {
              for (let x = 0; x < tw; x++) {
                const pi = (y * tw + x) * bpp;
                if (iconMask[y * tw + x] < 128) iconPixels[pi + 3] = 0;
                else iconOpaque++;
              }
            }
            const iconBuffer = await sharp.default(iconPixels, { raw: { width: tw, height: th, channels: 4 } }).trim().png().toBuffer();

            // Frame: apply frameMask as alpha
            const framePixels = new Uint8Array(rawPixels);
            let frameOpaque = 0;
            for (let y = 0; y < th; y++) {
              for (let x = 0; x < tw; x++) {
                const pi = (y * tw + x) * bpp;
                if (frameMask[y * tw + x] < 128) framePixels[pi + 3] = 0;
                else frameOpaque++;
              }
            }
            const frameBuffer = await sharp.default(framePixels, { raw: { width: tw, height: th, channels: 4 } }).trim().png().toBuffer();

            const iconT = ((tw * th - iconOpaque) / (tw * th) * 100).toFixed(1);
            const frameT = ((tw * th - frameOpaque) / (tw * th) * 100).toFixed(1);
            console.log(`[verify] ${label} core=${iconT}% frame=${frameT}% full=${fullPct}% method=${isRound ? "round" : "ellipse"}`);
            if (iconT === "0.0") console.warn(`[verify] ${label} core=0% — BUG, icon mask all-zero`);
            if (frameT === fullPct) console.warn(`[verify] ${label} frame==full — BUG, not punched`);

            const iconUrl = await persistImage(`data:image/png;base64,${iconBuffer.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_core`);
            const frameUrl = await persistImage(`data:image/png;base64,${frameBuffer.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_frame`);

            const iconAsset = await prisma.asset.create({ data: { name: `${label}_${sceneId.slice(0, 6)}_core`, type: group.type as any, subType: "core", pngUrl: iconUrl, transparent: true, componentGroupId: group.id, sceneId } });
            const frameAsset = await prisma.asset.create({ data: { name: `${label}_${sceneId.slice(0, 6)}_frame`, type: group.type as any, subType: "frame", pngUrl: frameUrl, transparent: true, componentGroupId: group.id, sceneId } });
            assets.push(iconAsset, frameAsset);

            // Plus badge extraction
            if (plusBadgeMask) {
              const plusPixels = new Uint8Array(rawPixels);
              for (let y = 0; y < th; y++) {
                for (let x = 0; x < tw; x++) {
                  const pi = (y * tw + x) * bpp;
                  if (plusBadgeMask[y * tw + x] < 128) plusPixels[pi + 3] = 0;
                }
              }
              const plusBuffer = await sharp.default(plusPixels, { raw: { width: tw, height: th, channels: 4 } }).trim().png().toBuffer();
              const plusUrl = await persistImage(`data:image/png;base64,${plusBuffer.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_plus`);
              const plusAsset = await prisma.asset.create({ data: { name: `${label}_${sceneId.slice(0, 6)}_plus`, type: group.type as any, subType: "plus", pngUrl: plusUrl, transparent: true, componentGroupId: group.id, sceneId } });
              assets.push(plusAsset);
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