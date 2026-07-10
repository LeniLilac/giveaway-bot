import { describe, expect, it } from "vitest";
import {
  candidateHash,
  canonicalCandidates,
  selectWeightedWinners,
  type Candidate,
} from "./selection";

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

  it("is deterministic and selects without replacement", () => {
    const snapshot = candidateHash(candidates);
    const randomness = "11".repeat(32);
    const first = selectWeightedWinners(candidates, 3, randomness, snapshot, 1);
    const second = selectWeightedWinners(candidates, 3, randomness, snapshot, 1);
    expect(first.map((winner) => winner.userId)).toEqual(
      second.map((winner) => winner.userId),
    );
    expect(new Set(first.map((winner) => winner.userId)).size).toBe(3);
  });

  it("caps winners at the candidate count", () => {
    const winners = selectWeightedWinners(
      candidates,
      10,
      "22".repeat(32),
      candidateHash(candidates),
      1,
    );
    expect(winners).toHaveLength(3);
  });
});
