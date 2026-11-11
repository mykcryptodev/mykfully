import { randomBytes } from "node:crypto";
import { SignJWT, importJWK, importPKCS8, type CryptoKey } from "jose";

/**
 * Coinbase Developer Platform API-key JWT (same format as `generateJwt` in @coinbase/cdp-sdk/auth), implemented
 * with jose so we don't depend on the SDK. Supports PEM EC (ES256) keys and base64 Ed25519 (64-byte) keys.
 */
export async function generateCdpJwt(opts: {
  apiKeyId: string;
  apiKeySecret: string;
  requestMethod: string;
  requestHost: string;
  requestPath: string;
  expiresIn?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: opts.apiKeyId,
    iss: "cdp",
    uris: [`${opts.requestMethod} ${opts.requestHost}${opts.requestPath}`],
  };
  const { key, alg } = await importCdpKey(opts.apiKeySecret);
  return new SignJWT(claims)
    .setProtectedHeader({ alg, kid: opts.apiKeyId, typ: "JWT", nonce: randomBytes(16).toString("hex") })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + (opts.expiresIn ?? 120))
    .sign(key);
}

async function importCdpKey(secret: string): Promise<{ key: CryptoKey | Uint8Array; alg: "ES256" | "EdDSA" }> {
  const pem = secret.replace(/\\n/g, "\n");
  if (pem.includes("PRIVATE KEY")) return { key: await importPKCS8(pem, "ES256"), alg: "ES256" };
  const raw = Buffer.from(secret, "base64");
  if (raw.length !== 64) throw new Error("Invalid CDP API key secret format (expected PEM EC key or base64 Ed25519 key)");
  const key = await importJWK(
    { kty: "OKP", crv: "Ed25519", d: raw.subarray(0, 32).toString("base64url"), x: raw.subarray(32).toString("base64url") },
    "EdDSA",
  );
  return { key, alg: "EdDSA" };
}
