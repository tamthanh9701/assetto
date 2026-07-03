import "server-only";

export async function persistImage(
  sourceUrl: string,
  prefix: string
): Promise<string> {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;

  if (!blobToken) {
    console.warn(
      "[storage] BLOB_READ_WRITE_TOKEN not set — returning original URL (may expire). " +
        "Set this env var on Vercel for permanent storage."
    );
    if (sourceUrl.startsWith("data:")) {
      throw new Error(
        "[storage] Cannot persist base64 image without BLOB_READ_WRITE_TOKEN. " +
          "The image would be stored as a giant string in the database. " +
          "Please set BLOB_READ_WRITE_TOKEN in your environment."
      );
    }
    return sourceUrl;
  }

  const { put } = await import("@vercel/blob");
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Failed to fetch source image: ${res.status}`);
  const blob = await res.blob();
  const ext = blob.type === "image/png" ? "png" : "jpg";
  const filename = `${prefix}_${Date.now()}.${ext}`;
  const result = await put(filename, blob, { access: "public" });
  return result.url;
}

export async function persistBase64Image(
  dataUrl: string,
  prefix: string
): Promise<string> {
  const matches = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!matches) return dataUrl;

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    throw new Error(
      "[storage] Cannot persist base64 image without BLOB_READ_WRITE_TOKEN. " +
        "Gemini returns images as base64 data URIs that must be uploaded to blob storage. " +
        "Please set BLOB_READ_WRITE_TOKEN in your environment."
    );
  }

  const mime = matches[1];
  const ext = mime === "image/png" ? "png" : "jpg";
  const buffer = Buffer.from(matches[2], "base64");

  const { put } = await import("@vercel/blob");
  const filename = `${prefix}_${Date.now()}.${ext}`;
  const result = await put(filename, buffer, { access: "public" });
  return result.url;
}