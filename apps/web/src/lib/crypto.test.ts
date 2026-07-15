import { afterEach, describe, expect, it, vi } from "vitest";
import { decrypt, encrypt, signPayload, verifyPayload } from "./crypto";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("web cryptographic secrets", () => {
  it("rejects weak OAuth encryption keys", () => {
    vi.stubEnv("OAUTH_ENCRYPTION_KEY", "too-short");
    expect(() => encrypt("token")).toThrow("at least 32 bytes");
  });

  it("rejects weak session signing keys", () => {
    vi.stubEnv("SESSION_SECRET", "too-short");
    expect(() => signPayload({ state: "test" })).toThrow("at least 32 bytes");
  });

  it("round-trips encrypted and signed values with strong independent keys", () => {
    vi.stubEnv("OAUTH_ENCRYPTION_KEY", "oauth-encryption-key-material-32-bytes");
    vi.stubEnv("SESSION_SECRET", "session-signing-key-material-32-bytes");

    expect(decrypt(encrypt("discord-token"))).toBe("discord-token");
    expect(verifyPayload(signPayload({ state: "test" }))).toEqual({ state: "test" });
  });
});
