export const LEGACY_PROOF_VERSION = "lilac-weighted-v1" as const;
export const PROOF_VERSION = "lilac-weighted-v2" as const;
export const PROOF_SCHEMA = "lilac-giveaway-proof/v2";
export const SNAPSHOT_SCHEMA = "lilac-giveaway-candidates/v2";
export const DRAW_ALGORITHM = PROOF_VERSION;

export type ProofVersion = typeof LEGACY_PROOF_VERSION | typeof PROOF_VERSION;

export interface ProofCandidate {
  /** Discord identity used only to preserve the historical v1 ordering contract. */
  userId: string;
  /** Stable, non-reversible identity committed by v2 proofs. */
  participantId: string;
  /** Snapshot order assigned from joinedAt, then Discord user ID. */
  ordinal: number;
  joinedAt: Date | string;
  weight: number;
}

export interface CanonicalCandidateV1 {
  userId: string;
  joinedAt: string;
  weight: number;
}

export interface CanonicalCandidateV2 {
  participantId: string;
  joinedAt: string;
  weight: number;
}

export type CanonicalCandidate = CanonicalCandidateV1 | CanonicalCandidateV2;

function candidateTime(candidate: ProofCandidate): number {
  const value = new Date(candidate.joinedAt).getTime();
  if (!Number.isFinite(value)) throw new Error("Candidate join time is invalid.");
  return value;
}

function compareLegacyCandidates(left: ProofCandidate, right: ProofCandidate): number {
  const joined = candidateTime(left) - candidateTime(right);
  if (joined !== 0) return joined;
  return left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0;
}

function compareV2Candidates(left: ProofCandidate, right: ProofCandidate): number {
  return left.ordinal - right.ordinal;
}

function validateCandidate(candidate: ProofCandidate, version: ProofVersion): void {
  candidateTime(candidate);
  if (!candidate.userId) throw new Error("Candidate user IDs must not be empty.");
  if (version === PROOF_VERSION) {
    if (!/^[a-f0-9]{64}$/i.test(candidate.participantId)) {
      throw new Error("Participant IDs must be 32-byte hexadecimal values.");
    }
    if (!Number.isSafeInteger(candidate.ordinal) || candidate.ordinal < 0) {
      throw new Error("Candidate ordinals must be non-negative safe integers.");
    }
  }
  if (!Number.isSafeInteger(candidate.weight) || candidate.weight <= 0) {
    throw new Error("Candidate weights must be positive safe integers.");
  }
}

function orderedCandidates(
  candidates: ProofCandidate[],
  version: ProofVersion,
): ProofCandidate[] {
  const ordered = [...candidates].sort(
    version === LEGACY_PROOF_VERSION ? compareLegacyCandidates : compareV2Candidates,
  );
  ordered.forEach((candidate) => validateCandidate(candidate, version));
  if (version === PROOF_VERSION) {
    ordered.forEach((candidate, index) => {
      if (candidate.ordinal !== index) {
        throw new Error("V2 candidate ordinals must be contiguous from zero.");
      }
    });
  }
  return ordered;
}

export function canonicalCandidates(
  candidates: ProofCandidate[],
  version: ProofVersion = PROOF_VERSION,
): CanonicalCandidate[] {
  return orderedCandidates(candidates, version).map((candidate) =>
    version === LEGACY_PROOF_VERSION
      ? {
          userId: candidate.userId,
          joinedAt: new Date(candidate.joinedAt).toISOString(),
          weight: candidate.weight,
        }
      : {
          participantId: candidate.participantId.toLowerCase(),
          joinedAt: new Date(candidate.joinedAt).toISOString(),
          weight: candidate.weight,
        },
  );
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function u64(value: bigint): Uint8Array {
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, value, false);
  return output;
}

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("Counter is outside the uint32 range.");
  }
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

export function hexToBytes(value: string): Uint8Array {
  if (!/^[a-fA-F0-9]*$/.test(value) || value.length % 2 !== 0) {
    throw new Error("Invalid hexadecimal value.");
  }
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

export function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256(value: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy.buffer));
}

export async function candidateHash(
  candidates: ProofCandidate[],
  version: ProofVersion = PROOF_VERSION,
): Promise<string> {
  return bytesToHex(await sha256(JSON.stringify(canonicalCandidates(candidates, version))));
}

async function randomBelow(
  seed: Uint8Array,
  winnerIndex: number,
  maximum: bigint,
): Promise<bigint> {
  if (maximum <= 0n) throw new Error("Random bound must be positive.");
  const range = 1n << 256n;
  const ceiling = range - (range % maximum);
  for (let attempt = 0; ; attempt += 1) {
    const digest = await sha256(concat(seed, u64(BigInt(winnerIndex)), u32(attempt)));
    const value = BigInt(`0x${bytesToHex(digest)}`);
    if (value < ceiling) return value % maximum;
  }
}

export async function selectWeightedWinners<T extends ProofCandidate>(
  candidates: T[],
  winnerCount: number,
  randomnessHex: string,
  snapshotHash: string,
  drawNumber: number,
  version: ProofVersion = PROOF_VERSION,
): Promise<T[]> {
  if (!Number.isSafeInteger(winnerCount) || winnerCount < 0) {
    throw new Error("Winner count must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(drawNumber) || drawNumber <= 0) {
    throw new Error("Draw number must be a positive safe integer.");
  }
  if (!/^[a-fA-F0-9]{64}$/.test(randomnessHex) || !/^[a-fA-F0-9]{64}$/.test(snapshotHash)) {
    throw new Error("Randomness and snapshot hash must be 32-byte hexadecimal values.");
  }
  const pool = orderedCandidates(candidates, version) as T[];
  const seed = await sha256(
    concat(
      hexToBytes(randomnessHex),
      hexToBytes(snapshotHash),
      new TextEncoder().encode(drawNumber.toString()),
    ),
  );
  const winners: T[] = [];
  const count = Math.min(winnerCount, pool.length);
  for (let selection = 0; selection < count; selection += 1) {
    const total = pool.reduce((sum, candidate) => sum + BigInt(candidate.weight), 0n);
    let target = await randomBelow(seed, selection, total);
    let selectedIndex = 0;
    for (let index = 0; index < pool.length; index += 1) {
      const weight = BigInt(pool[index]!.weight);
      if (target < weight) {
        selectedIndex = index;
        break;
      }
      target -= weight;
    }
    winners.push(pool[selectedIndex]!);
    pool.splice(selectedIndex, 1);
  }
  return winners;
}
