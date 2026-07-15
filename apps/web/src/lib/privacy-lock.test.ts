import { describe, expect, it, vi } from "vitest";
import {
  completedFenceAllowsFreshConsent,
  databaseClockMillis,
  lockPrivacyAffectedGiveaways,
} from "./privacy-lock";

describe("privacy deletion OAuth fence", () => {
  const completedAt = new Date("2026-07-15T12:00:00.000Z");

  it("rejects a callback initiated before or at deletion completion", () => {
    expect(completedFenceAllowsFreshConsent(completedAt, completedAt.getTime() - 1)).toBe(false);
    expect(completedFenceAllowsFreshConsent(completedAt, completedAt.getTime())).toBe(false);
  });

  it("allows deliberate consent initiated after deletion completion", () => {
    expect(completedFenceAllowsFreshConsent(completedAt, completedAt.getTime() + 1)).toBe(true);
  });

  it("always rejects an incomplete fence", () => {
    expect(completedFenceAllowsFreshConsent(null, Date.now())).toBe(false);
  });

  it("uses PostgreSQL time for OAuth issuance and fence comparisons", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("clock_timestamp()");
      return { rows: [{ now_ms: "1784116800123" }] };
    });
    await expect(databaseClockMillis({ query } as never)).resolves.toBe(1_784_116_800_123);
  });

  it("serializes a deletion request with every affected giveaway snapshot", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("ORDER BY giveaway.id");
      expect(sql).toContain("FOR UPDATE");
      expect(params).toEqual(["123"]);
      return { rows: [] };
    });
    await lockPrivacyAffectedGiveaways({ query } as never, "123");

    expect(query).toHaveBeenCalledTimes(1);
  });
});
