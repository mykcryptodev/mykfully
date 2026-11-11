import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { decodeProtectedHeader, importSPKI, jwtVerify, importJWK } from "jose";
import { generateCdpJwt } from "@/lib/payments/cdpJwt";

const req = { requestMethod: "POST", requestHost: "api.cdp.coinbase.com", requestPath: "/platform/v2/x402/settle" };

describe("generateCdpJwt", () => {
  it("signs ES256 with a PEM EC key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwt = await generateCdpJwt({ apiKeyId: "kid1", apiKeySecret: pem, ...req });
    const h = decodeProtectedHeader(jwt);
    expect([h.alg, h.kid, h.typ, typeof h.nonce]).toEqual(["ES256", "kid1", "JWT", "string"]);
    const { payload } = await jwtVerify(jwt, await importSPKI(publicKey.export({ type: "spki", format: "pem" }).toString(), "ES256"));
    expect(payload).toMatchObject({ sub: "kid1", iss: "cdp", uris: ["POST api.cdp.coinbase.com/platform/v2/x402/settle"] });
    expect(payload.exp! - payload.iat!).toBe(120);
  });

  it("signs EdDSA with a base64 64-byte Ed25519 key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
    const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
    const jwt = await generateCdpJwt({ apiKeyId: "kid2", apiKeySecret: secret, ...req });
    expect(decodeProtectedHeader(jwt).alg).toBe("EdDSA");
    const pub = await importJWK({ ...(publicKey.export({ format: "jwk" }) as object), alg: "EdDSA" } as never, "EdDSA");
    await expect(jwtVerify(jwt, pub)).resolves.toBeTruthy();
  });

  it("rejects malformed secrets", async () => {
    await expect(generateCdpJwt({ apiKeyId: "k", apiKeySecret: "nope", ...req })).rejects.toThrow();
  });
});
