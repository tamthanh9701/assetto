import "server-only";

export async function persistImage(
  sourceUrl: string,
  prefix: string
): Promise<string> {
  try {
    const { put } = await import("@vercel/blob");
    const res = await fetch(sourceUrl);
    if (!res.ok) throw new Error(`Failed to fetch source image: ${res.status}`);
    const blob = await res.blob();
    const ext = blob.type === "image/png" ? "png" : "jpg";
    const filename = `${prefix}_${Date.now()}.${ext}`;
    const result = await put(filename, blob, { access: "public", addRandomSuffix: true });
    return result.url;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[storage] persistImage failed for ${prefix}: ${message}`);
    // Fallback: return original URL — blob upload is non-critical
    return sourceUrl;
  }
}

export async function persistBase64Image(
  dataUrl: string,
  prefix: string
): Promise<string> {
  const matches = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!matches) return dataUrl;

  try {
    const mime = matches[1];
    const ext = mime === "image/png" ? "png" : "jpg";
    const buffer = Buffer.from(matches[2], "base64");

    const { put } = await import("@vercel/blob");
    const filename = `${prefix}_${Date.now()}.${ext}`;
    const result = await put(filename, buffer, { access: "public", addRandomSuffix: true });
    return result.url;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[storage] persistBase64Image failed for ${prefix}: ${message}`);
    // Fallback: return data URL — blob upload is non-critical
    return dataUrl;
  }
}