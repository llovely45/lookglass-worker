const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export const SESSION_COOKIE_NAME = "lookglass_session";
export const SESSION_COOKIE_MAX_AGE = 24 * 60 * 60;

const encoder = new TextEncoder();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }

  try {
    const padding = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export function getSessionExpiration(cookie: string | undefined): number | null {
  if (typeof cookie !== "string") {
    return null;
  }

  const parts = cookie.split(".");
  if (
    parts.length !== 3 ||
    !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
    !/^\d+$/.test(parts[1]) ||
    !/^[A-Za-z0-9_-]+$/.test(parts[2])
  ) {
    return null;
  }

  const expiration = Number(parts[1]);
  return Number.isSafeInteger(expiration) ? expiration : null;
}

/** Create the opaque value stored in the session cookie. */
export async function createSessionCookie(
  secret: string,
  nowMs: number,
): Promise<string> {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = encodeBase64Url(nonceBytes);
  const expiration = Math.trunc(nowMs) + SESSION_TTL_MS;
  const signedValue = `${nonce}.${expiration}`;
  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedValue),
  );

  return `${signedValue}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** Verify the cookie value without disclosing why an invalid value failed. */
export async function verifySessionCookie(
  cookie: string | undefined,
  secret: string,
  nowMs: number,
): Promise<boolean> {
  if (typeof cookie !== "string") {
    return false;
  }

  const parts = cookie.split(".");
  if (parts.length !== 3) {
    return false;
  }

  const [nonce, expirationText, signatureText] = parts;
  const expiration = getSessionExpiration(cookie);
  if (expiration === null || !/^[A-Za-z0-9_-]+$/.test(signatureText)) {
    return false;
  }

  if (Math.trunc(nowMs) >= expiration) {
    return false;
  }

  const signature = decodeBase64Url(signatureText);
  if (!signature || signature.length !== 32) {
    return false;
  }
  const signatureBuffer = new ArrayBuffer(signature.byteLength);
  new Uint8Array(signatureBuffer).set(signature);

  try {
    const key = await importSigningKey(secret);
    return await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBuffer,
      encoder.encode(`${nonce}.${expirationText}`),
    );
  } catch {
    return false;
  }
}
