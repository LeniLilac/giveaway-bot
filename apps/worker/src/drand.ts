import { createHash } from "node:crypto";

export interface ChainInfo {
  hash: string;
  period: number;
  genesis_time: number;
  public_key: string;
  scheme: string;
}

export interface DrandBeacon {
  round: number;
  randomness: string;
  signature: string;
  previous_signature?: string;
}

export interface DrandClientOptions {
  chainHash: string;
  baseUrls: string[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "Lilac-Giveaway-Bot/0.1" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Drand returned HTTP ${response.status}.`);
  return (await response.json()) as T;
}

export async function fetchChainInfo(options: DrandClientOptions): Promise<ChainInfo> {
  let lastError: unknown;
  for (const baseUrl of options.baseUrls) {
    try {
      const info = await fetchJson<ChainInfo>(
        `${baseUrl.replace(/\/$/, "")}/${options.chainHash}/info`,
      );
      if (info.hash.toLowerCase() !== options.chainHash.toLowerCase()) {
        throw new Error("Drand chain hash did not match the configured chain.");
      }
      return info;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All drand endpoints failed.");
}

export function roundAtOrAfter(info: ChainInfo, timestampSeconds: number): bigint {
  if (timestampSeconds <= info.genesis_time) return 1n;
  return BigInt(Math.floor((timestampSeconds - info.genesis_time) / info.period) + 1);
}

export function roundTime(info: ChainInfo, round: bigint): Date {
  return new Date((info.genesis_time + (Number(round) - 1) * info.period) * 1000);
}

export async function fetchBeacon(
  options: DrandClientOptions,
  round: bigint,
): Promise<DrandBeacon> {
  let lastError: unknown;
  for (const baseUrl of options.baseUrls) {
    try {
      const beacon = await fetchJson<DrandBeacon>(
        `${baseUrl.replace(/\/$/, "")}/${options.chainHash}/public/${round.toString()}`,
      );
      if (BigInt(beacon.round) !== round) throw new Error("Drand returned the wrong round.");
      if (!/^[a-f0-9]{64}$/i.test(beacon.randomness)) {
        throw new Error("Drand returned malformed randomness.");
      }
      if (!/^[a-f0-9]+$/i.test(beacon.signature)) {
        throw new Error("Drand returned a malformed signature.");
      }
      const derived = createHash("sha256")
        .update(Buffer.from(beacon.signature, "hex"))
        .digest("hex");
      if (derived !== beacon.randomness.toLowerCase()) {
        throw new Error("Drand randomness does not match SHA-256(signature).");
      }
      return beacon;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All drand endpoints failed.");
}
