import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/ai/registry";
import { persistImage } from "@/lib/storage";
import { Receiver } from "@upstash/qstash";
import Replicate from "replicate";

export const maxDuration = 300;

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN || "", useFileOutput: false });

const MATTING_RETRIES = 2;

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
});

async function matteImage(cropBuffer: Buffer, isBackground: boolean): Promise<{ buffer: Buffer; w: number; h: number; method: string }> {
  const sharp = await import("sharp");
  let meta = await sharp.default(cropBuffer).metadata();
  let w = meta.width || 0, h = meta.height || 0;

  if (isBackground) {
    const buf = await sharp.default(cropBuffer, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    return { buffer: buf, w, h, method: "background" };
  }

  let matted: Buffer | null = null;
  let method = "fallback";

  for (let attempt = 0; attempt <= MATTING_RETRIES; attempt++) {
    try {
      const inputBase64 = (await sharp.default(cropBuffer, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()).toString("base64");
      const dataUrl = `data:image/png;base64,${inputBase64}`;

      const output = await replicate.run(
        "men1scus/birefnet:9aef7538a7e5e6318dd7cbbfb8cd18aa76d5258e6ef2c4117e3e9f40d45c9ea7",
        { input: { image: dataUrl } }
      );

      let url: string | null = null;
      if (typeof output === "string") url = output;
      else if (Array.isArray(output)) url = typeof output[0] === "string" ? output[0] : null;
      else if (output && typeof (output as any).url === "function") url = (output as any).url();

      if (url) {
        const res = await fetch(url);
        if (res.ok) {
          matted = Buffer.from(await res.arrayBuffer());
          method = "birefnet";
          break;
        }
      }
    } catch (e) {
      console.warn(`[matting] attempt ${attempt} failed:`, e instanceof Error ? e.message : e);
    }
  }

  if (matted) {
    const resized = await sharp.default(matted)
      .resize(w, h, { fit: "fill" })
      .png()
      .toBuffer();
    return { buffer: resized, w, h, method };
  }

  // Fallback: chroma-key
  console.warn("[matting] BiRefNet failed, fallback to chromaKey");
  const keyed = Buffer.from((() => {
    const pixels = new Uint8Array(cropBuffer);
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
      if (colorDist(px, bgColor) > 28) continue;
      pixels[pi + 3] = 0;
      const x = i % w;
      const y = Math.floor(i / w);
      if (x > 0) queue.push(i - 1);
      if (x < w - 1) queue.push(i + 1);
      if (y > 0) queue.push(i - w);
      if (y < h - 1) queue.push(i + w);
    }
    return pixels;
  })());

  const buf = await sharp.default(keyed, { raw: { width: w, height: h, channels: 4 } }).trim().png().toBuffer();
  const trimmed = await sharp.default(buf).metadata();
  return { buffer: buf, w: trimmed.width || w, h: trimmed.height || h, method: "chromaKey" };
}

const SAM_RETRIES = 1;

async function splitWithSAM(cleanPng: Buffer, w: number, h: number, isRound: boolean): Promise<{ iconMask: Uint8Array; frameMask: Uint8Array; samUsed: boolean }> {
  const sharp = await import("sharp");
  const rawPixels = await sharp.default(cleanPng).ensureAlpha().raw().toBuffer();
  const bpp = 4;

  let iconMask: Uint8Array | null = null;

  for (let attempt = 0; attempt <= SAM_RETRIES; attempt++) {
    try {
      const inputBase64 = (await sharp.default(cleanPng).png().toBuffer()).toString("base64");
      const dataUrl = `data:image/png;base64,${inputBase64}`;

      // Point prompt at center of crop — pixel coords
      const cx = Math.round(w / 2);
      const cy = Math.round(h / 2);

      // meta/sam-2 expects: image, point_coords string "[[x1,y1],[x2,y2]]", point_labels string "1,1"
      const output = await replicate.run(
        "meta/sam-2",
        {
          input: {
            image: dataUrl,
            point_coords: JSON.stringify([[cx, cy]]),
            point_labels: "1",
          },
        }
      );

      let maskUrl: string | null = null;
      if (typeof output === "string") maskUrl = output;
      else if (Array.isArray(output)) maskUrl = typeof output[0] === "string" ? output[0] : null;
      else if (output && typeof (output as any).url === "function") maskUrl = (output as any).url();

      // SAM-2 returns image with mask, not just mask — need to also handle output from https://replicate.com/meta/sam-2
      // It may return { mask: "url", combined: "url" } or just mask url string.
      if (output && typeof output === "object" && !Array.isArray(output)) {
        maskUrl = (output as any).mask || (output as any).combined || null;
      }

      if (maskUrl) {
        const res = await fetch(maskUrl);
        if (res.ok) {
          const maskBuf = Buffer.from(await res.arrayBuffer());
          const resized = await sharp.default(maskBuf).resize(w, h, { fit: "fill" }).grayscale().raw().toBuffer();
          iconMask = new Uint8Array(resized);
          break;
        }
      }
    } catch (e) {
      console.warn(`[sam] attempt ${attempt} failed:`, e instanceof Error ? e.message : e);
    }
  }

  if (iconMask) {
    for (let i = 0; i < w * h; i++) iconMask[i] = iconMask[i] > 128 ? 255 : 0;

    const frameMask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const pi = i * bpp;
      if (rawPixels[pi + 3] > 100 && iconMask[i] === 0) frameMask[i] = 255;
    }
    return { iconMask, frameMask, samUsed: true };
  }

  // Fallback: splitLocal with real isRound
  console.warn("[sam] SAM failed, fallback to splitLocal");
  const fallback = splitLocal(rawPixels, w, h, isRound);
  return { iconMask: fallback.iconMask, frameMask: fallback.frameMask, samUsed: false };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

interface Rgba { r: number; g: number; b: number; a: number }

function colorDist(a: Rgba, b: Rgba): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
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
        if (labels[ni] === -2) { labels[ni] = nextLabel; stack.push(ni); }
      }
    }
    nextLabel++;
  }
  return labels;
}

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

  const qw = Math.round(w * 0.35);
  const qh = Math.round(h * 0.35);
  let plusBadgeMask: Uint8Array | null = null;
  let hasRed = false;
  for (let y = 0; y < qh && y < h; y++) {
    for (let x = w - qw; x < w; x++) {
      const pi = (y * w + x) * bpp;
      if (src[pi + 3] > 128 && src[pi] > 180 && src[pi + 1] < 100 && src[pi + 2] < 100) { hasRed = true; break; }
    }
    if (hasRed) break;
  }
  if (hasRed) {
    plusBadgeMask = new Uint8Array(w * h);
    for (let y = 0; y < qh && y < h; y++) {
      for (let x = w - qw; x < w; x++) {
        const i = y * w + x;
        const pi = i * bpp;
        if (src[pi + 3] > 128 && src[pi] > 180 && src[pi + 1] < 100 && src[pi + 2] < 100) {
          plusBadgeMask[i] = 255;
          opaque[i] = 0;
        }
      }
    }
  }

  const cx = w / 2;
  const cy = h / 2;
  const Rmax = Math.min(w, h) / 2;
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
  const Rused = isRound ? Rmax : (Math.min(w, h) / 2) * Math.max(aspect, invAspect);

  const ringSamples: Rgba[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = distEllipse[i];
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

  const ringThreshold = isRound ? 0.60 : 0.55;
  const iconCandidate = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (opaque[i] > 0 && distEllipse[i] > ringThreshold * Rused) {
      const d = colorDist({ r: rArr[i], g: gArr[i], b: bArr[i], a: 255 }, ringColor);
      iconCandidate[i] = d < 75 ? 0 : 255;
    } else if (opaque[i] > 0) {
      iconCandidate[i] = 255;
    }
  }

  const opened = morphologyOpen(iconCandidate, w, h, 3);
  const labels = connectedComponents(opened, w, h, 128);
  const cxInt = Math.round(cx);
  const cyInt = Math.round(cy);
  const centerLabel = labels[cyInt * w + cxInt];

  const centerMask = new Uint8Array(w * h);
  if (centerLabel >= 0) {
    for (let i = 0; i < w * h; i++) centerMask[i] = (labels[i] === centerLabel) ? 255 : 0;
  } else {
    for (let i = 0; i < w * h; i++) centerMask[i] = opened[i];
  }

  const closed = morphologyClose(centerMask, w, h, 7);
  const iconMask = dilate(closed, w, h, 3);

  const frameMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    frameMask[i] = (opaque[i] > 0 && iconMask[i] === 0) ? 255 : 0;
  }

  return { iconMask, frameMask, plusBadgeMask };
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

export async function POST(req: Request) {
  const startTime = Date.now();
  let jobId: string | null = null;

  try {
    // Verify: QStash signature OR x-worker-secret
    const bodyText = await req.text();
    const qstashSig = req.headers.get("upstash-signature") || "";
    const directSecret = req.headers.get("x-worker-secret") || "";

    const isQStash = qstashSig.length > 0 && await receiver
      .verify({ signature: qstashSig, body: bodyText })
      .catch(() => false);
    const isDirect = directSecret === process.env.WORKER_SECRET;

    if (!isQStash && !isDirect) {
      console.warn("[worker] unauthorized access attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = JSON.parse(bodyText);
    jobId = body.jobId;
    if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    if (!job.metadata || typeof job.metadata !== "object" || !("imageUrl" in job.metadata)) {
      return NextResponse.json({ error: "Invalid job metadata" }, { status: 400 });
    }

    const { imageUrl } = job.metadata as { imageUrl: string };
    const sceneId = job.sceneId!;

    // Clean up old assets before re-extracting
    await prisma.asset.deleteMany({ where: { sceneId } });
    await prisma.componentGroup.deleteMany({ where: { sceneId } });

    await prisma.job.update({ where: { id: jobId }, data: { status: "processing", progress: 0 } });

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
    let processedCount = 0;
    let birefnetCount = 0;
    let samCount = 0;

    for (let batchStart = 0; batchStart < allElements.length; batchStart += CONCURRENCY) {
      const batch = allElements.slice(batchStart, batchStart + CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(async (seg) => {
          const label = seg.name;
          const type = seg.type;
          const isIcon = (type.startsWith("ICON") || type.startsWith("BUTTON") || type.startsWith("BADGE"));
          const isRound = isIcon && (() => {
            if (!seg.box2d) return false;
            const bw = (seg.box2d[3] - seg.box2d[1]), bh = (seg.box2d[2] - seg.box2d[0]);
            if (bw <= 0 || bh <= 0) return false;
            const r = bw / bh;
            return r >= 0.85 && r <= 1.18;
          })();
          const shouldSplit = isIcon && seg.box2d !== undefined;

          if (!seg.box2d) {
            const pngUrl = await persistImage(imageUrl, `comp_${sceneId.slice(0, 6)}_${label}`);
            const group = await getOrCreateGroup(sceneId, type, 0);
            await prisma.asset.create({ data: { name: `${label}_${sceneId.slice(0, 6)}`, type: group.type as any, pngUrl, transparent: true, componentGroupId: group.id, sceneId } });
            return { name: label, type: group.type, imageUrl: pngUrl };
          }

          const left = clamp(Math.round((seg.box2d[1] / 1000) * W), 0, W - 1);
          const top = clamp(Math.round((seg.box2d[0] / 1000) * H), 0, H - 1);
          const cw = clamp(Math.round(((seg.box2d[3] - seg.box2d[1]) / 1000) * W), 1, W - left);
          const ch = clamp(Math.round(((seg.box2d[2] - seg.box2d[0]) / 1000) * H), 1, H - top);

          let cropBuffer = await sharp.default(imgBuffer).extract({ left, top, width: cw, height: ch }).ensureAlpha().raw().toBuffer();
          const { buffer: mattedBuffer, w: tw, h: th, method } = await matteImage(cropBuffer, type === "BACKGROUND");
          const cleanPng = mattedBuffer;
          if (method === "birefnet") birefnetCount++;

          const group = await getOrCreateGroup(sceneId, type, batchStart + batch.indexOf(seg));
          const assets: any[] = [];

          if (shouldSplit) {
            const rawPixels = await sharp.default(cleanPng).ensureAlpha().raw().toBuffer();
            const { iconMask, frameMask, samUsed } = await splitWithSAM(cleanPng, tw, th, isRound);
            if (samUsed) samCount++;
            const bpp = 4;

            let fullOpaque = 0;
            for (let i = 0; i < tw * th; i++) { if (rawPixels[i * bpp + 3] > 100) fullOpaque++; }
            const fullPct = ((tw * th - fullOpaque) / (tw * th) * 100).toFixed(1);

            const iconPixels = new Uint8Array(rawPixels);
            let iconOpaque = 0;
            for (let y = 0; y < th; y++) {
              for (let x = 0; x < tw; x++) {
                if (iconMask[y * tw + x] >= 128) iconOpaque++;
                else iconPixels[(y * tw + x) * bpp + 3] = 0;
              }
            }
            const iconBuffer = await sharp.default(iconPixels, { raw: { width: tw, height: th, channels: 4 } }).trim().png().toBuffer();

            const framePixels = new Uint8Array(rawPixels);
            let frameOpaque = 0;
            for (let y = 0; y < th; y++) {
              for (let x = 0; x < tw; x++) {
                if (frameMask[y * tw + x] >= 128) frameOpaque++;
                else framePixels[(y * tw + x) * bpp + 3] = 0;
              }
            }

            const iconT = ((tw * th - iconOpaque) / (tw * th) * 100).toFixed(1);
            const frameT = ((tw * th - frameOpaque) / (tw * th) * 100).toFixed(1);
            console.log(`[worker] ${label} core=${iconT}% frame=${frameT}% full=${fullPct}% split=${samUsed ? "SAM" : "local"}`);

            // Plus badge detection — scan top-right quadrant for red pixels
            const qw = Math.round(tw * 0.35);
            const qh = Math.round(th * 0.35);
            let hasRed = false;
            for (let y = 0; y < qh && y < th; y++) {
              for (let x = tw - qw; x < tw; x++) {
                const pi = (y * tw + x) * bpp;
                if (rawPixels[pi + 3] > 128 && rawPixels[pi] > 180 && rawPixels[pi + 1] < 100 && rawPixels[pi + 2] < 100) { hasRed = true; break; }
              }
              if (hasRed) break;
            }

            if (hasRed) {
              const plusPixels = new Uint8Array(rawPixels);
              for (let y = 0; y < th; y++) {
                for (let x = 0; x < tw; x++) {
                  const i = y * tw + x;
                  const pi = i * bpp;
                  const isRed = (x >= tw - qw && y < qh && rawPixels[pi + 3] > 128 && rawPixels[pi] > 180 && rawPixels[pi + 1] < 100 && rawPixels[pi + 2] < 100);
                  if (isRed) {
                    // Keep red pixels visible in plus image
                    // Do nothing — keep alpha
                    // Also punch from frame
                    framePixels[pi + 3] = 0;
                  } else {
                    // Everything else transparent in plus image
                    plusPixels[pi + 3] = 0;
                  }
                }
              }
              const plusBuffer = await sharp.default(plusPixels, { raw: { width: tw, height: th, channels: 4 } }).trim().png().toBuffer();
              const plusUrl = await persistImage(`data:image/png;base64,${plusBuffer.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_plus`);
              const plusAsset = await prisma.asset.create({ data: { name: `${label}_${sceneId.slice(0, 6)}_plus`, type: group.type as any, subType: "plus", pngUrl: plusUrl, transparent: true, componentGroupId: group.id, sceneId } });
              assets.push(plusAsset);

              // Re-upload frame with plus punched out
              const fixedFrame = await sharp.default(framePixels, { raw: { width: tw, height: th, channels: 4 } }).trim().png().toBuffer();
              const fixedFrameUrl = await persistImage(`data:image/png;base64,${fixedFrame.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_frame`);
              await prisma.asset.updateMany({
                where: { sceneId, name: `${label}_${sceneId.slice(0, 6)}_frame` },
                data: { pngUrl: fixedFrameUrl },
              });
            } else {
              // No plus badge — save frame as-is
              const frameBuffer = await sharp.default(framePixels, { raw: { width: tw, height: th, channels: 4 } }).trim().png().toBuffer();
              const frameUrl = await persistImage(`data:image/png;base64,${frameBuffer.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_frame`);
              const frameAsset = await prisma.asset.create({ data: { name: `${label}_${sceneId.slice(0, 6)}_frame`, type: group.type as any, subType: "frame", pngUrl: frameUrl, transparent: true, componentGroupId: group.id, sceneId } });
              assets.push(frameAsset);
            }

            const iconUrl = await persistImage(`data:image/png;base64,${iconBuffer.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}_core`);
            const iconAsset = await prisma.asset.create({ data: { name: `${label}_${sceneId.slice(0, 6)}_core`, type: group.type as any, subType: "core", pngUrl: iconUrl, transparent: true, componentGroupId: group.id, sceneId } });
            assets.push(iconAsset);
          }

          const mainPngUrl = await persistImage(`data:image/png;base64,${cleanPng.toString("base64")}`, `comp_${sceneId.slice(0, 6)}_${label}`);
          await prisma.asset.create({ data: { name: `${label}_${sceneId.slice(0, 6)}`, type: group.type as any, pngUrl: mainPngUrl, transparent: true, componentGroupId: group.id, sceneId } });

          return { name: label, type: group.type, imageUrl: mainPngUrl };
        })
      );

      for (const r of batchResults) {
        if (r.status === "fulfilled") results.push(r.value);
        else console.warn("[worker] batch failed:", r.reason);
      }

      processedCount += batch.length;
      await prisma.job.update({
        where: { id: jobId },
        data: { progress: Math.round((processedCount / allElements.length) * 100) },
      });
    }

    if (results.length === 0) {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: "failed", error: "0 components extracted — all processing failed" },
      });
      console.error(`[worker] 0 components for job ${jobId}`);
      return NextResponse.json({ error: "No components extracted" }, { status: 500 });
    }

    // Create ZIP of all scene assets
    const sceneAssets = await prisma.asset.findMany({
      where: { sceneId },
      select: { name: true, pngUrl: true, subType: true },
    });

    if (sceneAssets.length > 0) {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();

      for (const asset of sceneAssets) {
        if (!asset.pngUrl) continue;
        try {
          const res = await fetch(asset.pngUrl);
          if (!res.ok) continue;
          const buf = await res.arrayBuffer();
          const folder = asset.subType || "main";
          zip.file(`${folder}/${asset.name}.png`, buf);
        } catch {
          console.warn(`[worker] failed to add ${asset.name} to ZIP`);
        }
      }

      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      const { put } = await import("@vercel/blob");
      const zipResult = await put(`zip_${sceneId.slice(0, 6)}_${Date.now()}.zip`, zipBuffer, {
        access: "public",
        addRandomSuffix: true,
      });

      await prisma.job.update({
        where: { id: jobId },
        data: { status: "completed", progress: 100, resultZipUrl: zipResult.url },
      });
    } else {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: "failed", error: "0 assets in ZIP" },
      });
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[worker] ${results.length} components, ${birefnetCount} matted via BiRefNet, ${samCount} split via SAM, ${duration}s for job ${jobId}`);
    return NextResponse.json({ components: results.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[worker] error:", message);
    if (jobId) {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: "failed", error: message },
      }).catch(() => {});
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}