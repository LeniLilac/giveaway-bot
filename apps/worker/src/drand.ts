import { createHash } from "node:crypto";
import {
  fetchBeacon as fetchVerifiedBeacon,
  type Chain,
  type ChainClient,
  type ChainInfo as ClientChainInfo,
  type ChainOptions,
  type RandomnessBeacon,
} from "drand-client";

export interface ChainInfo {
  hash: string;
  period: number;
  genesis_time: number;
  public_key: string;
  schemeID: string;
}

export type DrandBeacon = RandomnessBeacon;

export interface DrandClientOptions {
  chainHash: string;
  publicKey: string;
  period: number;
  genesisTime: number;
  scheme: string;
  baseUrls: string[];
  requestTimeoutMs?: number;
}

function chainUrl(baseUrl: string, chainHash: string): string {
  const base = baseUrl.replace(/\/$/, "");
  return base.toLowerCase().endsWith(`/${chainHash.toLowerCase()}`)
    ? base
    : `${base}/${chainHash}`;
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Drand relay timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Drand relay returned HTTP ${response.status}.`);
        }
        return await response.json() as T;
      })(),
      timedOut,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

class BoundedHttpChain implements Chain {
  constructor(
    readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  info(): Promise<ClientChainInfo> {
    return fetchJsonWithTimeout<ClientChainInfo>(`${this.baseUrl}/info`, this.timeoutMs);
  }
}

class BoundedHttpClient implements ChainClient {
  readonly options: ChainOptions;

  constructor(
    private readonly boundedChain: BoundedHttpChain,
    options: DrandClientOptions,
    private readonly timeoutMs: number,
  ) {
    this.options = {
      disableBeaconVerification: false,
      noCache: false,
      chainVerificationParams: {
        chainHash: options.chainHash,
        publicKey: options.publicKey,
      },
    };
  }

  chain(): Chain {
    return this.boundedChain;
  }

  get(roundNumber: number): Promise<RandomnessBeacon> {
    return fetchJsonWithTimeout<RandomnessBeacon>(
      `${this.boundedChain.baseUrl}/public/${roundNumber}`,
      this.timeoutMs,
    );
  }

  latest(): Promise<RandomnessBeacon> {
    return fetchJsonWithTimeout<RandomnessBeacon>(
      `${this.boundedChain.baseUrl}/public/latest`,
      this.timeoutMs,
    );
  }
}

function clientFor(baseUrl: string, options: DrandClientOptions): BoundedHttpClient {
  const timeoutMs = options.requestTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("Drand request timeout must be between 1ms and 60000ms.");
  }
  const clientOptions = {
    disableBeaconVerification: false,
    noCache: false,
    chainVerificationParams: {
      chainHash: options.chainHash,
      publicKey: options.publicKey,
    },
  };
  void clientOptions;
  return new BoundedHttpClient(
    new BoundedHttpChain(chainUrl(baseUrl, options.chainHash), timeoutMs),
    options,
    timeoutMs,
  );
}

function validatePinnedInfo(
  info: ClientChainInfo,
  options: DrandClientOptions,
): ChainInfo {
  if (info.hash.toLowerCase() !== options.chainHash.toLowerCase()) {
    throw new Error("Drand chain hash did not match the pinned chain.");
  }
  if (info.public_key.toLowerCase() !== options.publicKey.toLowerCase()) {
    throw new Error("Drand public key did not match the pinned key.");
  }
  if (
    info.period !== options.period ||
    info.genesis_time !== options.genesisTime ||
    info.schemeID !== options.scheme
  ) {
    throw new Error("Drand timing or signature scheme did not match pinned chain metadata.");
  }
  return info;
}

export async function fetchChainInfo(options: DrandClientOptions): Promise<ChainInfo> {
  let lastError: unknown;
  for (const baseUrl of options.baseUrls) {
    try {
      const info = await clientFor(baseUrl, options).chain().info();
      return validatePinnedInfo(info, options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All drand endpoints failed.");
}

/** First round whose emission time is greater than or equal to timestampSeconds. */
export function roundAtOrAfter(info: ChainInfo, timestampSeconds: number): bigint {
  if (!Number.isFinite(timestampSeconds)) throw new Error("Drand target time is invalid.");
  if (timestampSeconds <= info.genesis_time) return 1n;
  return BigInt(Math.ceil((timestampSeconds - info.genesis_time) / info.period) + 1);
}

export function roundTime(info: ChainInfo, round: bigint): Date {
  if (round < 1n || round > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Drand round is outside the supported range.");
  }
  return new Date((info.genesis_time + (Number(round) - 1) * info.period) * 1000);
}

export async function fetchBeacon(
  options: DrandClientOptions,
  committedChainHash: string,
  round: bigint,
): Promise<DrandBeacon> {
  if (committedChainHash.toLowerCase() !== options.chainHash.toLowerCase()) {
    throw new Error("The committed drand chain is not the currently pinned chain.");
  }
  if (round < 1n || round > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("The committed drand round is outside the supported range.");
  }
  let lastError: unknown;
  for (const baseUrl of options.baseUrls) {
    try {
      const client = clientFor(baseUrl, options);
      const info = await client.chain().info();
      validatePinnedInfo(info, options);
      const beacon = await fetchVerifiedBeacon(client, Number(round));
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
