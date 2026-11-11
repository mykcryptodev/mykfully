import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./env";

/**
 * AES-256-GCM for OAuth tokens at rest.
 *
 * - v2 (current): "v2:<iv b64>:<tag b64>:<ciphertext b64>", 12-byte IV, 16-byte tag, AAD = the owning userId,
 *   so a ciphertext copied onto another user's row fails to decrypt.
 * - v1 (legacy, read-only): same layout without AAD. Rewritten as v2 on the next token save/refresh.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: { raw: string; key: Buffer } | null = null;

function getKey(): Buffer {
  const raw = env.tokenEncKey;
  if (cachedKey?.raw === raw) return cachedKey.key;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (e.g. `openssl rand -base64 32`)");
  }
  cachedKey = { raw, key };
  return key;
}

function requireAad(aad: string): Buffer {
  if (!aad) throw new Error("encryption AAD (userId) is required");
  return Buffer.from(aad, "utf8");
}

export function encrypt(plaintext: string, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(requireAad(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v2", iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt(payload: string, aad: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || (parts[0] !== "v1" && parts[0] !== "v2")) throw new Error("Invalid encrypted payload format");
  const [version, ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_BYTES) throw new Error("Invalid encrypted payload: bad IV length");
  if (tag.length !== TAG_BYTES) throw new Error("Invalid encrypted payload: bad auth tag length");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv, { authTagLength: TAG_BYTES });
  if (version === "v2") decipher.setAAD(requireAad(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/** True if the payload predates v2 and should be re-encrypted. */
export function isLegacyCiphertext(payload: string): boolean {
  return payload.startsWith("v1:");
}
