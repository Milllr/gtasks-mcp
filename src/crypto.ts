/**
 * Stateless signed blobs. Everything the OAuth layer needs to remember is
 * encoded into the token itself and signed with HMAC-SHA256, so the Worker
 * needs no KV, no D1 and no Durable Object. Rotating SIGNING_SECRET revokes
 * every outstanding credential at once.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Sign an arbitrary payload. `ttlSeconds` of 0 means the blob never expires. */
export async function sign(
  secret: string,
  payload: object,
  ttlSeconds: number,
): Promise<string> {
  const body = { ...payload } as Record<string, unknown>;
  if (ttlSeconds > 0) body.exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const encoded = toBase64Url(encoder.encode(JSON.stringify(body)));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(encoded));
  return `${encoded}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Verify and decode a blob. Returns null on a bad signature or expiry. */
export async function verify<T = Record<string, unknown>>(
  secret: string,
  token: string,
): Promise<T | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const key = await hmacKey(secret);
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(signature),
      encoder.encode(encoded),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const payload = JSON.parse(decoder.decode(fromBase64Url(encoded)));
    if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) return null;
    return payload as T;
  } catch {
    return null;
  }
}

/** Constant time string comparison, for the password check. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** SHA-256 then base64url, for PKCE S256 verification. */
export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

export function randomId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}
