import {
  candidateHash as hashCandidates,
  canonicalCandidates as canonicalizeCandidates,
  selectWeightedWinners as selectWinners,
  type CanonicalCandidate,
  type ProofCandidate,
} from "@lilac/proof";

export interface Candidate extends ProofCandidate {
  username: string;
  joinedAt: Date;
}

export function canonicalCandidates(candidates: Candidate[]): CanonicalCandidate[] {
  return canonicalizeCandidates(candidates);
}

export function candidateHash(candidates: Candidate[]): Promise<string> {
  return hashCandidates(candidates);
}

export function selectWeightedWinners(
  candidates: Candidate[],
  winnerCount: number,
  randomnessHex: string,
  snapshotHash: string,
  drawNumber: number,
): Promise<Candidate[]> {
  return selectWinners(candidates, winnerCount, randomnessHex, snapshotHash, drawNumber);
}
