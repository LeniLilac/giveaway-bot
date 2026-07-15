import {
  candidateHash as hashCandidates,
  canonicalCandidates as canonicalizeCandidates,
  selectWeightedWinners as selectWinners,
  type CanonicalCandidate,
  type ProofCandidate,
  type ProofVersion,
} from "@lilac/proof";

export interface Candidate extends ProofCandidate {
  username: string;
  joinedAt: Date;
}

export function canonicalCandidates(
  candidates: Candidate[],
  version?: ProofVersion,
): CanonicalCandidate[] {
  return canonicalizeCandidates(candidates, version);
}

export function candidateHash(candidates: Candidate[], version?: ProofVersion): Promise<string> {
  return hashCandidates(candidates, version);
}

export function selectWeightedWinners(
  candidates: Candidate[],
  winnerCount: number,
  randomnessHex: string,
  snapshotHash: string,
  drawNumber: number,
  version?: ProofVersion,
): Promise<Candidate[]> {
  return selectWinners(
    candidates,
    winnerCount,
    randomnessHex,
    snapshotHash,
    drawNumber,
    version,
  );
}
