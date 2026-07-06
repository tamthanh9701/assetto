import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/ai/registry";
import { persistImage } from "@/lib/storage";
import { Receiver } from "@upstash/qstash";
import Replicate from "replicate";

export const maxDuration = 300;

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN || "", useFileOutput: false });
const MATTING_RETRIES = 2;
const CONCURRENCY = 4;

type Box2D = [number, number, number, number];
type ComponentGroupType = "BACKGROUND" | "PANEL" | "BUTTON" | "ICON" | "BAR" | "BADGE" | "CHARACTER" | "SPRITE" | "CUSTOM";
type AssetType = "SCENE" | "CHARACTER" | "ICON" | "SPRITE" | "COMPONENT";

type LayerComponent = {
  name: string;
  type: string;
  imageUrl?: string;
  box2d?: Box2D;
};

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
});

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function colorDist(a: Rgba, b: Rgba): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function sanitizeName(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "component";
}

function groupTypeFor(type: string): ComponentGroupType {
  const normalized = type.toUpperCase();
  if (normalized === "BACKGROUND") return "BACKGROUND";
  if (normalized === "PANEL") return "PANEL";
  if (normalized.startsWith("BUTTON")) return "BUTTON";
  if (normalized.startsWith("ICON")) return "ICON";
  if (normalized.startsWith("BAR")) return "BAR";
  if (normalized.startsWith("BADGE")) return "BADGE";
  if (normalized === "CHARACTER") return "CHARACTER";
  if (normalized === "SPRITE") return "SPRITE";
  return "CUSTOM";
}

function assetTypeForGroup(type: string): AssetType {
  const normalized = type.toUpperCase();
  if (normalized === "CHARACTER") return "CHARACTER";
  if (normalized === "ICON") return "ICON";
  if (normalized === "SPRITE") return "SPRITE";
  return "COMPONENT";
}

function extractReplicateUrl(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return typeof output[0] === "string" ? output[0] : null;
  if (output && typeof output === "object") {
    const maybeOutput = output as any;
    if (typeof maybeOutput.url === "function") return maybeOutput.url();
    if (typeof maybeOutput.url === "string") return maybeOutput.url;
    if (typeof maybeOutput.image === "string") return maybeOutput.image;
    if (typeof maybeOutput.output === "string") return maybeOutput.output;
  }
  return null;
}

function boxToCrop(box: Box2D, W: number, H: number, padding = 3) {
  const [y1, x1, y2, x2] = box;
  const left = clamp(Math.round((x1 / 1000) * W) - padding, 0, W - 1);
  const top = clamp(Math.round((y1 / 1000) * H) - padding, 0, H - 1);
  const right = clamp(Math.round((x2 / 1000) * W) + padding, left + 1, W);
  const bottom = clamp(Math.round((y2 / 1000) * H) + padding, top + 1, H);

  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

async function edgeChromaKey(cropPng: Buffer): Promise<{ buffer: Buffer; w: number; h: number; method: string }> {
  const sharp = await import("sharp");
  const raw = await sharp.default(cropPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(raw.data);
  const w = raw.info.width;
  const h = raw.info.height;
  const bpp = raw.info.channels;
  const stride = w * bpp;

  const pixelAt = (x: number, y: number): Rgba => {
    const pi = y * stride + x * bpp;
    return { r: pixels[pi], g: pixels[pi + 1], b: pixels[pi + 2], a: pixels[pi + 3] };
  };

  const corners = [pixelAt(0, 0), pixelAt(w - 1, 0), pixelAt(0, h - 1), pixelAt(w - 1, h - 1)];
  const bgColor: Rgba = {
    r: Math.round(corners.reduce((sum, c) => sum + c.r, 0) / corners.length),
    g: Math.round(corners.reduce((sum, c) => sum + c.g, 0) / corners.length),
    b: Math.round(corners.reduce((sum, c) => sum + c.b, 0) / corners.length),
    a: 255,
  };

  const visited = new Uint8Array(w * h);
  const queue: number[] = [];
  const idx = (x: number, y: number) => y * w + x;

  for (let x = 0; x < w; x++) queue.push(idx(x, 0), idx(x, h - 1));
  for (let y = 0; y < h; y++) queue.push(idx(0, y), idx(w - 1, y));

  let qi = 0;
  while (qi < queue.length) {
    const i = queue[qi++];
    if (visited[i]) continue;
    visited[i] = 1;

    const x = i % w;
    const y = Math.floor(i / w);
    const pi = y * stride + x * bpp;
    const px: Rgba = { r: pixels[pi], g: pixels[pi + 1], b: pixels[pi + 2], a: pixels[pi + 3] };

    if (px.a < 12 || colorDist(px, bgColor) <= 34) {
      pixels[pi + 3] = 0;
      if (x > 0) queue.push(i - 1);
      if (x < w - 1) queue.push(i + 1);
      if (y > 0) queue.push(i - w);
      if (y < h - 1) queue.push(i + w);
    }
  }

  const transparentPng = await sharp.default(Buffer.from(pixels), {
    raw: { width: w, height: h, channels: bpp },
  })
    .trim()
    .png()
    .toBuffer()
    .catch(() =>
      sharp.default(Buffer.from(pixels), { raw: { width: w, height: h, channels: bpp } }).png().toBuffer()
    );

  const meta = await sharp.default(transparentPng).metadata();
  return { buffer: transparentPng, w: meta.width || w, h: meta.height || h, method: "edge-chroma" };
}

async function matteImage(cropPng: Buffer, isBackground: boolean): Promise<{ buffer: Buffer; w: number; h: number; method: string }> {
  const sharp = await import("sharp");
  const meta = await sharp.default(cropPng).ensureAlpha().metadata();
  const w = meta.width || 1;
  const h = meta.height || 1;

  if (isBackground || !process.env.REPLICATE_API_TOKEN) {
    const buffer = await sharp.default(cropPng).ensureAlpha().png().toBuffer();
    return { buffer, w, h, method: isBackground ? "background" : "png" };
  }

  let matted: Buffer | null = null;
  let method = "birefnet";

  for (let attempt = 0; attempt <= MATTING_RETRIES; attempt++) {
    try {
      const inputBase64 = (await sharp.default(cropPng).ensureAlpha().png().toBuffer()).toString("base64");
      const dataUrl = `data:image/png;base64,${inputBase64}`;

      const output = await replicate.run(
        "men1scus/birefnet:9aef7538a7e5e6318dd7cbbfb8cd18aa76d5258e6ef2c4117e3e9f40d45c9ea7",
        { input: { image: dataUrl } }
      );

      const url = extractReplicateUrl(output);
      if (!url) continue;

      const res = await fetch(url);
      if (!res.ok) continue;

      matted = Buffer.from(await res.arrayBuffer());
      break;
    } catch (e) {
      console.warn(`[matting] attempt ${attempt} failed:`, e instanceof Error ? e.message : e);
    }
  }

  if (matted) {
    const buffer = await sharp.default(matted)
      .resize(w, h, { fit: "fill" })
      .ensureAlpha()
      .trim()
      .png()
      .toBuffer()
      .catch(() => sharp.default(matted!).resize(w, h, { fit: "fill" }).ensureAlpha().png().toBuffer());
    const resultMeta = await sharp.default(buffer).metadata();
    return { buffer, w: resultMeta.width || w, h: resultMeta.height || h, method };
  }

  console.warn("[matting] BiRefNet failed, falling back to edge chroma key");
  method = "edge-chroma";
  return edgeChromaKey(cropPng);
}

async function getOrCreateGroup(sceneId: string, type: string, order: number) {
  const groupType = groupTypeFor(type);
  let group = await prisma.componentGroup.findFirst({ where: { sceneId, type: groupType as any } });
  if (!group) {
    group = await prisma.componentGroup.create({
      data: {
        name: groupType.charAt(0) + groupType.slice(1).toLowerCase(),
        type: groupType as any,
        order,
        sceneId,
      },
    });
  }
  return group;
}

export async function POST(req: Request) {
  const startTime = Date.now();
  let jobId: string | null = null;

  try {
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

    await prisma.asset.deleteMany({ where: { sceneId } });
    await prisma.componentGroup.deleteMany({ where: { sceneId } });
    await prisma.job.update({ where: { id: jobId }, data: { status: "processing", progress: 0, error: null } });

    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`Failed to fetch source image: ${imgRes.status}`);
    const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

    const sharp = await import("sharp");
    const imgMeta = await sharp.default(imgBuffer).metadata();
    const W = imgMeta.width || 1024;
    const H = imgMeta.height || 576;

    const provider = getProvider("extract");
    const segmentResult = await provider.extractLayers({ imageUrl });
    const allElements = (segmentResult.components || []) as LayerComponent[];

    if (allElements.length === 0) {
      throw new Error("No elements detected by extraction provider");
    }

    const results: { id: string; name: string; type: string; imageUrl: string | null }[] = [];
    let processedCount = 0;
    let birefnetCount = 0;
    let fallbackCount = 0;

    for (let batchStart = 0; batchStart < allElements.length; batchStart += CONCURRENCY) {
      const batch = allElements.slice(batchStart, batchStart + CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(async (seg, index) => {
          const type = groupTypeFor(seg.type);
          const label = sanitizeName(seg.name || type);
          const crop = seg.box2d
            ? boxToCrop(seg.box2d, W, H, type === "BACKGROUND" ? 0 : 4)
            : { left: 0, top: 0, width: W, height: H };

          const cropPng = await sharp.default(imgBuffer)
            .extract(crop)
            .ensureAlpha()
            .png()
            .toBuffer();

          const { buffer: mattedBuffer, w, h, method } = await matteImage(cropPng, type === "BACKGROUND");
          if (method === "birefnet") birefnetCount++;
          if (method === "edge-chroma") fallbackCount++;

          const group = await getOrCreateGroup(sceneId, type, batchStart + index);
          const pngUrl = await persistImage(
            `data:image/png;base64,${mattedBuffer.toString("base64")}`,
            `comp_${sceneId.slice(0, 6)}_${label}`
          );

          const asset = await prisma.asset.create({
            data: {
              name: `${label}_${sceneId.slice(0, 6)}`,
              type: assetTypeForGroup(group.type),
              subType: "main",
              pngUrl,
              transparent: type !== "BACKGROUND",
              width: w,
              height: h,
              order: batchStart + index,
              componentGroupId: group.id,
              sceneId,
            },
          });

          return { id: asset.id, name: asset.name, type, imageUrl: asset.pngUrl };
        })
      );

      for (const r of batchResults) {
        if (r.status === "fulfilled") results.push(r.value);
        else console.warn("[worker] component failed:", r.reason);
      }

      processedCount += batch.length;
      await prisma.job.update({
        where: { id: jobId },
        data: { progress: Math.round((processedCount / allElements.length) * 100) },
      });
    }

    if (results.length === 0) {
      throw new Error("0 components extracted — all processing failed");
    }

    const sceneAssets = await prisma.asset.findMany({
      where: { sceneId },
      select: { name: true, pngUrl: true, subType: true },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    });

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

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[worker] ${results.length} components, ${birefnetCount} via BiRefNet, ${fallbackCount} fallback, ${duration}s for job ${jobId}`);
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
