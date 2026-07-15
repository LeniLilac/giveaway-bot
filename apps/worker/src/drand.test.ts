import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchBeacon,
  fetchChainInfo,
  roundAtOrAfter,
  roundTime,
  type DrandClientOptions,
} from "./drand.js";

const options: DrandClientOptions = {
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  period: 3,
  genesisTime: 1692803367,
  scheme: "bls-unchained-g1-rfc9380",
  baseUrls: ["https://relay.invalid"],
};

const info = {
  public_key: options.publicKey,
  period: options.period,
  genesis_time: options.genesisTime,
  hash: options.chainHash,
  groupHash: "f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e",
  schemeID: options.scheme,
  metadata: { beaconID: "quicknet" },
};

afterEach(() => vi.unstubAllGlobals());

describe("pinned and verified drand", () => {
  it("uses ceil semantics at and between round boundaries", () => {
    const tiny = { ...info, hash: "00", public_key: "00", genesis_time: 100, period: 3 };
    expect(roundAtOrAfter(tiny, 100)).toBe(1n);
    expect(roundAtOrAfter(tiny, 101)).toBe(2n);
    expect(roundAtOrAfter(tiny, 103)).toBe(2n);
    expect(roundAtOrAfter(tiny, 104)).toBe(3n);
    expect(roundTime(tiny, 3n).toISOString()).toBe("1970-01-01T00:01:46.000Z");
  });

  it("rejects relay timing metadata even when hash and key match", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...info, period: 30 }))));
    await expect(fetchChainInfo(options)).rejects.toThrow("timing or signature scheme");
  });

  it("rejects a relay with the wrong pinned key or hash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(info))));
    await expect(fetchChainInfo({ ...options, publicKey: "00".repeat(96) })).rejects.toThrow();
    await expect(fetchChainInfo({ ...options, chainHash: "11".repeat(32) })).rejects.toThrow();
  });

  it("rejects a forged beacon signature through the official verifier", async () => {
    const signature = "00".repeat(48);
    const randomness = createHash("sha256").update(Buffer.from(signature, "hex")).digest("hex");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        return new Response(
          JSON.stringify(url.endsWith("/info") ? info : { round: 123, signature, randomness }),
        );
      }),
    );
    await expect(fetchBeacon(options, options.chainHash, 123n)).rejects.toThrow();
  });

  it("refuses to fetch from a chain different from the committed one", async () => {
    await expect(fetchBeacon(options, "ff".repeat(32), 1n)).rejects.toThrow(
      "committed drand chain",
    );
  });

  it("aborts a hung relay and fails over to the next relay", async () => {
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("https://hung.invalid")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }
      return Promise.resolve(new Response(JSON.stringify(info)));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchChainInfo({
      ...options,
      baseUrls: ["https://hung.invalid", "https://healthy.invalid"],
      requestTimeoutMs: 10,
    })).resolves.toMatchObject({ hash: options.chainHash });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("times out even when a fetch implementation ignores its AbortSignal", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    await expect(fetchChainInfo({
      ...options,
      requestTimeoutMs: 10,
    })).rejects.toThrow("timed out");
  });
});
