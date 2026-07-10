export const PROOF_SCHEMA = "lilac-giveaway-proof/v1";
export const SNAPSHOT_SCHEMA = "lilac-giveaway-candidates/v1";
export const DRAW_ALGORITHM = "lilac-giveaway/draw/v1";

export interface DrawCandidate {
  userId: string;
  joinedAt: string;
  messageCountAtJoin: string | null;
  matchedBonusRoleIds: string[];
  baseEntries: "1";
  bonusEntries: string;
  weight: string;
}

export interface DrawSnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  giveawayId: string;
  drawOrdinal: number;
  closedAt: string;
  excludedPriorWinnerIds: string[];
  candidates: DrawCandidate[];
}

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

export function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
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

export function hexToBytes(value: string): Uint8Array {
  if (!/^[a-fA-F0-9]*$/.test(value) || value.length % 2) throw new Error("Invalid hexadecimal value.");
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

export async function hashSnapshot(snapshot: DrawSnapshot): Promise<string> {
  return bytesToHex(await sha256(canonicalJson(snapshot as unknown as CanonicalValue)));
}

class FenwickTree {
  readonly tree: bigint[];
  constructor(weights: bigint[]) {
    this.tree = Array.from({ length: weights.length + 1 }, () => 0n);
    weights.forEach((weight, index) => this.add(index, weight));
  }
  add(index: number, delta: bigint): void {
    for (let cursor = index + 1; cursor < this.tree.length; cursor += cursor & -cursor) this.tree[cursor] = this.tree[cursor]! + delta;
  }
  total(): bigint {
    let sum = 0n;
    for (let cursor = this.tree.length - 1; cursor > 0; cursor -= cursor & -cursor) sum += this.tree[cursor]!;
    return sum;
  }
  findByTicket(ticket: bigint): number {
    let index = 0;
    let prefix = 0n;
    let bit = 1;
    while ((bit << 1) < this.tree.length) bit <<= 1;
    for (; bit; bit >>= 1) {
      const next = index + bit;
      if (next < this.tree.length && prefix + this.tree[next]! <= ticket) {
        index = next;
        prefix += this.tree[next]!;
      }
    }
    return index;
  }
}

export async function selectWeightedWinners(args: {
  snapshot: DrawSnapshot;
  snapshotHash: string;
  randomness: string;
  requestedWinners: bigint;
}): Promise<string[]> {
  const candidates = [...args.snapshot.candidates].sort((left, right) => {
    const a = BigInt(left.userId);
    const b = BigInt(right.userId);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const weights = candidates.map((candidate) => BigInt(candidate.weight));
  if (weights.some((weight) => weight <= 0n)) throw new Error("Candidate weights must be positive.");
  const picks = Number(args.requestedWinners > BigInt(candidates.length) ? BigInt(candidates.length) : args.requestedWinners);
  const seed = await sha256(concat(
    new TextEncoder().encode(`${DRAW_ALGORITHM}$0`),
    hexToBytes(args.randomness),
    hexToBytes(args.snapshotHash),
    new TextEncoder().encode(args.snapshot.giveawayId),
    u64(BigInt(args.snapshot.drawOrdinal))
  ));
  const tree = new FenwickTree(weights);
  const winners: string[] = [];
  const range = 1n << 256n;
  for (let pick = 0; pick < picks; pick += 1) {
    const total = tree.total();
    const limit = range - (range % total);
    let counter = 0n;
    let random = 0n;
    do {
      const block = await sha256(concat(seed, u64(BigInt(pick)), u64(counter)));
      random = BigInt(`0x${bytesToHex(block)}`);
      counter += 1n;
    } while (random >= limit);
    const index = tree.findByTicket(random % total);
    winners.push(candidates[index]!.userId);
    tree.add(index, -weights[index]!);
  }
  return winners;
}
