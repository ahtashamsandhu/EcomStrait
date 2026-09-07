import "server-only";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

/**
 * Where uploaded store media is hosted.
 *
 * Cloudflare R2 when it's configured, Supabase storage otherwise. The fallback
 * isn't a nicety — it keeps local development and any self-hosted deployment
 * working without a Cloudflare account, and media uploaded before R2 was set up
 * keeps resolving afterwards, because each asset records its own provider.
 *
 * R2 is worth it for video especially: Supabase's free tier is 1GB of storage
 * and 5GB of egress, which one hero video and modest traffic will exhaust. R2
 * charges nothing for egress at all.
 */

export type MediaKind = "image" | "video";
export type MediaProvider = "supabase" | "r2";

export type UploadedMedia = {
  provider: MediaProvider;
  url: string;
  /** Provider handle for deletion: the object key, or the storage path. */
  externalId: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
};

/** Caps chosen to keep a single store's library modest and uploads responsive. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;

// No SVG: it can carry scripts, and the public bucket serves it with the
// uploader-declared content type.
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"];
const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

export function r2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET_NAME &&
      (process.env.R2_ENDPOINT || process.env.R2_ACCOUNT_ID) &&
      process.env.R2_PUBLIC_URL,
  );
}

/**
 * Reject anything we shouldn't accept before it reaches a provider.
 *
 * Type is checked against an allow-list rather than a deny-list: an upload
 * field that accepts arbitrary types is a vulnerability, not a feature. SVG is
 * included only because logos need it.
 */
export function validateUpload(
  kind: MediaKind,
  mimeType: string,
  bytes: number,
): { ok: true } | { ok: false; error: string } {
  const allowed = kind === "video" ? VIDEO_TYPES : IMAGE_TYPES;
  if (!allowed.includes(mimeType)) {
    return { ok: false, error: `${mimeType || "That file type"} isn't supported for ${kind}s.` };
  }
  const cap = kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (bytes > cap) {
    return { ok: false, error: `Too large — keep ${kind}s under ${Math.round(cap / 1024 / 1024)}MB.` };
  }
  return { ok: true };
}

let client: S3Client | null = null;

function r2(): S3Client {
  if (client) return client;
  const endpoint =
    process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  client = new S3Client({
    region: process.env.R2_REGION || "auto",
    endpoint,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    // R2 rejects the checksum headers newer AWS SDKs add by default.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return client;
}

/** Public URL for an object key, from the bucket's public or custom domain. */
export function r2PublicUrl(key: string): string {
  const base = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
  return `${base}/${key.replace(/^\/+/, "")}`;
}

export async function uploadToR2(
  file: File,
  key: string,
): Promise<UploadedMedia | { error: string }> {
  try {
    // R2 has no streaming upload through this command, so the file is buffered.
    // Acceptable at our size caps; anything larger would want a presigned PUT
    // straight from the browser.
    const body = new Uint8Array(await file.arrayBuffer());
    await r2().send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: key,
        Body: body,
        ContentType: file.type || "application/octet-stream",
        // Storefront media is immutable — a new upload gets a new key.
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    return {
      provider: "r2",
      url: r2PublicUrl(key),
      externalId: key,
      width: null,
      height: null,
      bytes: file.size,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't upload to R2." };
  }
}

/** Delete from whichever provider holds the bytes. Best-effort. */
export async function deleteFromProvider(
  provider: string,
  externalId: string | null,
): Promise<void> {
  if (!externalId || provider !== "r2" || !r2Configured()) return;
  try {
    await r2().send(
      new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: externalId }),
    );
  } catch {
    // A stranded object is untidy; failing the merchant's delete is worse.
  }
}
