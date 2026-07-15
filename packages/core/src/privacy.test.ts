import { describe, expect, it } from "vitest";
import { privacyFenceHash } from "./privacy.js";

describe("privacy deletion fence identity", () => {
  it("is deterministic, domain separated, and non-reversible", () => {
    const secret = "a-production-strength-secret-of-32-bytes";
    expect(privacyFenceHash(secret, "123")).toBe(privacyFenceHash(secret, "123"));
    expect(privacyFenceHash(secret, "123")).toMatch(/^[a-f0-9]{64}$/);
    expect(privacyFenceHash(secret, "123")).not.toBe(privacyFenceHash(secret, "124"));
  });

  it("rejects weak secrets", () => {
    expect(() => privacyFenceHash("too-short", "123")).toThrow("at least 32 bytes");
  });
});
