export const PROOF_SCHEMA = "lilac-giveaway-proof/v1";
export const SNAPSHOT_SCHEMA = "lilac-giveaway-candidates/v1";
export const DRAW_ALGORITHM = "lilac-weighted-v1";

export interface ProofCandidate {
  userId: string;
  joinedAt: Date | string;
  weight: number;
}

export interface CanonicalCandidate {
  userId: string;
  joinedAt: string;
  weight: number;
}

function candidateTime(candidate: ProofCandidate): number {
  const value = new Date(candidate.joinedAt).getTime();
  if (!Number.isFinite(value)) throw new Error("Candidate join time is invalid.");
  return value;
}

function compareCandidates(left: ProofCandidate, right: ProofCandidate): number {
  const joined = candidateTime(left) - candidateTime(right);
  if (joined !== 0) return joined;
  return left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0;
}

function validateCandidate(candidate: ProofCandidate): void {
  candidateTime(candidate);
  if (!Number.isSafeInteger(candidate.weight) || candidate.weight <= 0) {
    throw new Error("Candidate weights must be positive safe integers.");
  }
}

export function canonicalCandidates(candidates: ProofCandidate[]): CanonicalCandidate[] {
  return [...candidates].sort(compareCandidates).map((candidate) => {
    validateCandidate(candidate);
    return {
      userId: candidate.userId,
      joinedAt: new Date(candidate.joinedAt).toISOString(),
      weight: candidate.weight,
    };
  });
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

export async function candidateHash(candidates: ProofCandidate[]): Promise<string> {
  return bytesToHex(await sha256(JSON.stringify(canonicalCandidates(candidates))));
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
  const pool = [...candidates].sort(compareCandidates);
  pool.forEach(validateCandidate);
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
