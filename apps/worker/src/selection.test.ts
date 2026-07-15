import { describe, expect, it } from "vitest";
import {
  candidateHash,
  canonicalCandidates,
  selectWeightedWinners,
  type Candidate,
} from "./selection.js";

const candidates: Candidate[] = [
  { userId: "1", participantId: "1".repeat(64), ordinal: 0, username: "one", joinedAt: new Date("2026-01-01T00:00:01Z"), weight: 2 },
  { userId: "2", participantId: "2".repeat(64), ordinal: 1, username: "two", joinedAt: new Date("2026-01-01T00:00:01Z"), weight: 4 },
  { userId: "3", participantId: "3".repeat(64), ordinal: 2, username: "three", joinedAt: new Date("2026-01-01T00:00:02Z"), weight: 1 },
];

describe("public draw selection", () => {
  it("canonicalizes by join time and then user ID", () => {
    expect(canonicalCandidates(candidates).map((candidate) => "participantId" in candidate ? candidate.participantId[0] : "")).toEqual([
      "1", "2", "3",
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

  it("selects exactly the requested custom reroll count", async () => {
    const winners = await selectWeightedWinners(
      candidates,
      2,
      "33".repeat(32),
      await candidateHash(candidates),
      2,
    );
    expect(winners).toHaveLength(2);
    expect(new Set(winners.map((winner) => winner.userId)).size).toBe(2);
  });
});
