import { describe, expect, it } from "vitest";
import {
  LEGACY_PROOF_VERSION,
  candidateHash,
  canonicalCandidates,
  selectWeightedWinners,
  type ProofCandidate,
} from "./index.js";

const fixture: ProofCandidate[] = [
  {
    userId: "1",
    participantId: "a".repeat(64),
    ordinal: 0,
    joinedAt: new Date("2026-01-01T00:00:01.000Z"),
    weight: 2,
  },
  {
    userId: "2",
    participantId: "b".repeat(64),
    ordinal: 1,
    joinedAt: new Date("2026-01-01T00:00:01.000Z"),
    weight: 4,
  },
  {
    userId: "3",
    participantId: "c".repeat(64),
    ordinal: 2,
    joinedAt: new Date("2026-01-01T00:00:02.000Z"),
    weight: 1,
  },
];

const canonicalJson =
  '[{"participantId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","joinedAt":"2026-01-01T00:00:01.000Z","weight":2},{"participantId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","joinedAt":"2026-01-01T00:00:01.000Z","weight":4},{"participantId":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","joinedAt":"2026-01-01T00:00:02.000Z","weight":1}]';

describe("portable giveaway proof", () => {
  it("matches the fixed independent v2 fixture", async () => {
    expect(JSON.stringify(canonicalCandidates(fixture))).toBe(canonicalJson);
    await expect(candidateHash(fixture)).resolves.toBe(
      "904749d51e1de2dc15a0a21867a03e532096edb596d96257efa33001e9edadfc",
    );
    const winners = await selectWeightedWinners(
      fixture,
      3,
      "ab".repeat(32),
      "904749d51e1de2dc15a0a21867a03e532096edb596d96257efa33001e9edadfc",
      1,
    );
    expect(winners.map((candidate) => candidate.participantId[0])).toEqual(["b", "c", "a"]);
  });

  it("continues to support pre-migration v1 candidate snapshots", async () => {
    const legacy = fixture.map((candidate) => ({
      ...candidate,
      participantId: "",
      ordinal: -1,
    }));
    expect(canonicalCandidates(legacy, LEGACY_PROOF_VERSION)[0]).toEqual({
      userId: "1",
      joinedAt: "2026-01-01T00:00:01.000Z",
      weight: 2,
    });
    await expect(candidateHash(legacy, LEGACY_PROOF_VERSION)).resolves.toBe(
      "f00cd58d9bc4b7d5944ff8296854edec86c8ed58980072d3db0410b16fbd6bd2",
    );
    const winners = await selectWeightedWinners(
      legacy,
      3,
      "ab".repeat(32),
      "f00cd58d9bc4b7d5944ff8296854edec86c8ed58980072d3db0410b16fbd6bd2",
      1,
      LEGACY_PROOF_VERSION,
    );
    expect(winners.map((candidate) => candidate.userId)).toEqual(["2", "1", "3"]);
  });

  it("rejects non-contiguous v2 ordinals", async () => {
    await expect(candidateHash([{ ...fixture[0]!, ordinal: 1 }])).rejects.toThrow(
      "contiguous",
    );
  });
});
