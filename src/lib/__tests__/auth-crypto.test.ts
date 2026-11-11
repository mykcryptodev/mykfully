import { createCipheriv, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { decrypt, encrypt, isLegacyCiphertext } from "@/lib/crypto";
import { TEST_ENC_KEY, setAuthEnv } from "./auth-helpers";

function encryptV1(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(TEST_ENC_KEY, "base64"), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

beforeEach(setAuthEnv);

describe("token crypto", () => {
  it("round-trips v2 with AAD", () => {
    const enc = encrypt("secret-token", "u1");
    expect(enc.startsWith("v2:")).toBe(true);
    expect(isLegacyCiphertext(enc)).toBe(false);
    expect(decrypt(enc, "u1")).toBe("secret-token");
  });

  it("rejects v2 ciphertext under a different AAD (row swap)", () => {
    const enc = encrypt("secret-token", "u1");
    expect(() => decrypt(enc, "u2")).toThrow();
    expect(() => decrypt(enc, "")).toThrow();
  });

  it("still decrypts legacy v1 (no AAD) and re-encrypts as v2", () => {
    const v1 = encryptV1("old-token");
    expect(isLegacyCiphertext(v1)).toBe(true);
    const plain = decrypt(v1, "u1");
    expect(plain).toBe("old-token");
    const v2 = encrypt(plain, "u1");
    expect(v2.startsWith("v2:")).toBe(true);
    expect(decrypt(v2, "u1")).toBe("old-token");
  });

  it("rejects bad IV / tag lengths and tampering", () => {
    const [v, iv, tag, ct] = encrypt("x", "u1").split(":");
    expect(() => decrypt([v, Buffer.alloc(16).toString("base64"), tag, ct].join(":"), "u1")).toThrow(/IV/);
    expect(() => decrypt([v, iv, Buffer.alloc(8).toString("base64"), ct].join(":"), "u1")).toThrow(/tag/);
    expect(() => decrypt([v, iv, tag, Buffer.from("zz").toString("base64")].join(":"), "u1")).toThrow();
    expect(() => decrypt(`v3:${iv}:${tag}:${ct}`, "u1")).toThrow(/format/);
  });
});
