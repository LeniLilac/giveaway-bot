import { describe, expect, it } from "vitest";
import { normalizeReturnTo } from "./return-to";

describe("normalizeReturnTo", () => {
  it("keeps same-origin paths, queries, and fragments", () => {
    expect(normalizeReturnTo("/dashboard/guild/123?page=2#roles")).toBe(
      "/dashboard/guild/123?page=2#roles",
    );
  });

  it.each([
    "https://evil.example/path",
    "//evil.example/path",
    "/\\evil.example/path",
    "/%5cevil.example/path",
    "/dashboard%0d%0aLocation:%20https://evil.example",
  ])("rejects an unsafe redirect target: %s", (value) => {
    expect(normalizeReturnTo(value)).toBe("/dashboard");
  });

  it("uses the dashboard for missing and malformed values", () => {
    expect(normalizeReturnTo(null)).toBe("/dashboard");
    expect(normalizeReturnTo("not-a-path")).toBe("/dashboard");
  });
});
