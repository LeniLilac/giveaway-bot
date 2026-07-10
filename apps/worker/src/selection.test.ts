import { describe, expect, it } from "vitest";
import {
  candidateHash,
  canonicalCandidates,
  selectWeightedWinners,
  type Candidate,
} from "./selection.js";

const candidates: Candidate[] = [
  { userId: "3", username: "three", joinedAt: new Date("2026-01-01T00:00:02Z"), weight: 1 },
  { userId: "2", username: "two", joinedAt: new Date("2026-01-01T00:00:01Z"), weight: 4 },
  { userId: "1", username: "one", joinedAt: new Date("2026-01-01T00:00:01Z"), weight: 2 },
];

describe("public draw selection", () => {
  it("canonicalizes by join time and then user ID", () => {
    expect(canonicalCandidates(candidates).map((candidate) => candidate.userId)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("is deterministic and selects without replacement", async () => {
    const snapshot = await candidateHash(candidates);
    const randomness = "11".repeat(32);
    const first = await selectWeightedWinners(candidates, 3, randomness, snapshot, 1);
    const second = await selectWeightedWinners(candidates, 3, randomness, snapshot, 1);
    expect(first.map((winner) => winner.userId)).toEqual(
      second.map((winner) => winner.userId),
    );
    expect(new Set(first.map((winner) => winner.userId)).size).toBe(3);
  });

  it("caps winners at the candidate count", async () => {
    const winners = await selectWeightedWinners(
      candidates,
      10,
      "22".repeat(32),
      await candidateHash(candidates),
      1,
    );
    expect(winners).toHaveLength(3);
  });
});
