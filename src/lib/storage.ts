import "server-only";

export async function persistImage(
  sourceUrl: string,
  prefix: string
): Promise<string> {
  // Fallback local: store as base64 in env if no blob storage configured
  // Production: use Vercel Blob or Cloudflare R2
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (blobToken) {
    const { put } = await import("@vercel/blob");
    const res = await fetch(sourceUrl);
    const blob = await res.blob();
    const ext = blob.type === "image/png" ? "png" : "jpg";
    const filename = `${prefix}_${Date.now()}.${ext}`;
    const result = await put(filename, blob, { access: "public" });
    return result.url;
  }

  // No blob storage configured — return original URL as-is
  // In production, set BLOB_READ_WRITE_TOKEN env var
  return sourceUrl;
}

export async function persistBase64Image(
  dataUrl: string,
  prefix: string
): Promise<string> {
  const matches = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!matches) return dataUrl;

  const mime = matches[1];
  const ext = mime === "image/png" ? "png" : "jpg";
  const buffer = Buffer.from(matches[2], "base64");

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (blobToken) {
    const { put } = await import("@vercel/blob");
    const filename = `${prefix}_${Date.now()}.${ext}`;
    const result = await put(filename, buffer, { access: "public" });
    return result.url;
  }

  // Fallback: store as data URL (only for development, small images)
  return dataUrl;
}