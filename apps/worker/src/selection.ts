import { createHash } from "node:crypto";

export interface Candidate {
  userId: string;
  username: string;
  joinedAt: Date;
  weight: number;
}

interface CanonicalCandidate {
  userId: string;
  joinedAt: string;
  weight: number;
}

function sha256(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

export function canonicalCandidates(candidates: Candidate[]): CanonicalCandidate[] {
  return [...candidates]
    .sort((left, right) => {
      const joined = left.joinedAt.getTime() - right.joinedAt.getTime();
      if (joined !== 0) return joined;
      if (left.userId === right.userId) return 0;
      return left.userId < right.userId ? -1 : 1;
    })
    .map((candidate) => ({
      userId: candidate.userId,
      joinedAt: candidate.joinedAt.toISOString(),
      weight: candidate.weight,
    }));
}

export function candidateHash(candidates: Candidate[]): string {
  return sha256(JSON.stringify(canonicalCandidates(candidates))).toString("hex");
}

function randomBelow(seed: Buffer, counter: number, maximum: bigint): bigint {
  if (maximum <= 0n) throw new Error("Random bound must be positive.");
  const range = 1n << 256n;
  const ceiling = range - (range % maximum);
  let attempt = 0;
  while (true) {
    const digest = sha256(
      Buffer.concat([
        seed,
        Buffer.from(counter.toString(16).padStart(16, "0"), "hex"),
        Buffer.from(attempt.toString(16).padStart(8, "0"), "hex"),
      ]),
    );
    const value = BigInt(`0x${digest.toString("hex")}`);
    if (value < ceiling) return value % maximum;
    attempt += 1;
  }
}

export function selectWeightedWinners(
  candidates: Candidate[],
  winnerCount: number,
  randomnessHex: string,
  snapshotHash: string,
  drawNumber: number,
): Candidate[] {
  const pool = canonicalCandidates(candidates).map((canonical) => {
    const source = candidates.find((candidate) => candidate.userId === canonical.userId)!;
    return { ...source };
  });
  const seed = sha256(
    Buffer.concat([
      Buffer.from(randomnessHex, "hex"),
      Buffer.from(snapshotHash, "hex"),
      Buffer.from(drawNumber.toString()),
    ]),
  );
  const winners: Candidate[] = [];
  const count = Math.min(winnerCount, pool.length);
  for (let selection = 0; selection < count; selection += 1) {
    const total = pool.reduce((sum, candidate) => sum + BigInt(candidate.weight), 0n);
    let target = randomBelow(seed, selection, total);
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
