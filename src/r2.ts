import type { StatusSnapshot } from "./aggregate";

export const STATUS_SNAPSHOT_KEY = "public/status.json";
export const STATUS_CACHE_CONTROL = "public, max-age=30, must-revalidate";

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function payloadEtag(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return `"${bytesToHex(digest)}"`;
}

export async function writeStatusSnapshot(
  bucket: R2Bucket,
  snapshot: StatusSnapshot,
): Promise<void> {
  const payload = JSON.stringify(snapshot);
  const etag = await payloadEtag(payload);

  await bucket.put(STATUS_SNAPSHOT_KEY, payload, {
    httpMetadata: {
      contentType: "application/json",
      cacheControl: STATUS_CACHE_CONTROL,
    },
    customMetadata: { etag },
  });
}
