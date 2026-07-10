import { describe, expect, it } from "vitest";
import { candidateHash, canonicalCandidates, selectWeightedWinners } from "./index.js";

const fixture = [
  { userId: "3", joinedAt: new Date("2026-01-01T00:00:02.000Z"), weight: 1 },
  { userId: "2", joinedAt: new Date("2026-01-01T00:00:01.000Z"), weight: 4 },
  { userId: "1", joinedAt: new Date("2026-01-01T00:00:01.000Z"), weight: 2 },
];

describe("portable giveaway proof", () => {
  it("uses the documented canonical snapshot", async () => {
    expect(canonicalCandidates(fixture)).toEqual([
      { userId: "1", joinedAt: "2026-01-01T00:00:01.000Z", weight: 2 },
      { userId: "2", joinedAt: "2026-01-01T00:00:01.000Z", weight: 4 },
      { userId: "3", joinedAt: "2026-01-01T00:00:02.000Z", weight: 1 },
    ]);
    await expect(candidateHash(fixture)).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it("reproduces weighted winners without replacement", async () => {
    const snapshot = await candidateHash(fixture);
    const first = await selectWeightedWinners(fixture, 3, "ab".repeat(32), snapshot, 1);
    const second = await selectWeightedWinners(fixture, 3, "ab".repeat(32), snapshot, 1);
    expect(first.map((candidate) => candidate.userId)).toEqual(
      second.map((candidate) => candidate.userId),
    );
    expect(new Set(first.map((candidate) => candidate.userId)).size).toBe(3);
  });
});
