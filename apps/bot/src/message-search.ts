const DISCORD_EPOCH = 1_420_070_400_000n;
const DEFAULT_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 10_000;
const MAX_TOTAL_RETRY_DELAY_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5_000;
const MAX_CACHE_ENTRIES = 1_000;
const MAX_GLOBAL_SEARCHES = 4;
const MAX_GUILD_SEARCHES = 2;
const MAX_QUEUED_SEARCHES = 100;
const MAX_QUEUED_PER_GUILD = 20;

interface SearchBody {
  total_results?: number;
  retry_after?: number;
  message?: string;
  global?: boolean;
}

interface SearchQueueItem {
  guildId: string;
  run: () => Promise<number>;
  resolve: (value: number) => void;
  reject: (reason: unknown) => void;
}

interface CachedSearch {
  value: number;
  expiresAt: number;
}

export interface MessageSearchOptions {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxAttempts?: number;
  now?: () => number;
}

const inFlightSearches = new Map<string, Promise<number>>();
const resultCache = new Map<string, CachedSearch>();
const activeByGuild = new Map<string, number>();
const guildCooldowns = new Map<string, number>();
const searchQueue: SearchQueueItem[] = [];
let activeGlobal = 0;
let globalCooldown = 0;

function timestampToSnowflake(timestamp: number): string {
  return ((BigInt(timestamp) - DISCORD_EPOCH) << 22n).toString();
}

function retryDelay(response: Response, body: SearchBody): number {
  const rawHeader =
    response.headers.get("retry-after") ??
    response.headers.get("x-ratelimit-reset-after");
  const header = rawHeader === null ? Number.NaN : Number(rawHeader);
  const seconds =
    Number.isFinite(body.retry_after) && body.retry_after! >= 0
      ? body.retry_after!
      : Number.isFinite(header) && header >= 0
        ? header
        : DEFAULT_RETRY_DELAY_MS / 1_000;
  return Math.max(0, Math.ceil(seconds * 1_000));
}

function drainSearchQueue(): void {
  while (activeGlobal < MAX_GLOBAL_SEARCHES) {
    const index = searchQueue.findIndex(
      ({ guildId }) => (activeByGuild.get(guildId) ?? 0) < MAX_GUILD_SEARCHES,
    );
    if (index < 0) return;
    const [item] = searchQueue.splice(index, 1);
    if (!item) return;
    activeGlobal += 1;
    activeByGuild.set(item.guildId, (activeByGuild.get(item.guildId) ?? 0) + 1);
    void item
      .run()
      .then(item.resolve, item.reject)
      .finally(() => {
        activeGlobal -= 1;
        const remaining = (activeByGuild.get(item.guildId) ?? 1) - 1;
        if (remaining === 0) activeByGuild.delete(item.guildId);
        else activeByGuild.set(item.guildId, remaining);
        drainSearchQueue();
      });
  }
}

function scheduleSearch(guildId: string, run: () => Promise<number>): Promise<number> {
  const queuedForGuild = searchQueue.filter((item) => item.guildId === guildId).length;
  if (
    searchQueue.length >= MAX_QUEUED_SEARCHES ||
    queuedForGuild >= MAX_QUEUED_PER_GUILD
  ) {
    return Promise.reject(
      new Error("Discord message search is busy. Try joining again shortly."),
    );
  }
  return new Promise<number>((resolve, reject) => {
    searchQueue.push({ guildId, run, resolve, reject });
    drainSearchQueue();
  });
}

function setCooldown(guildId: string, delay: number, global: boolean, now: number): void {
  const until = now + delay;
  if (global) globalCooldown = Math.max(globalCooldown, until);
  else guildCooldowns.set(guildId, Math.max(guildCooldowns.get(guildId) ?? 0, until));
}

async function waitForCooldown(
  guildId: string,
  sleep: (milliseconds: number) => Promise<void>,
  now: () => number,
  remainingBudget: number,
): Promise<number> {
  const current = now();
  const until = Math.max(globalCooldown, guildCooldowns.get(guildId) ?? 0);
  const delay = Math.max(0, until - current);
  if (delay === 0) {
    if (globalCooldown <= current) globalCooldown = 0;
    if ((guildCooldowns.get(guildId) ?? 0) <= current) guildCooldowns.delete(guildId);
    return 0;
  }
  if (delay > MAX_RETRY_DELAY_MS || delay > remainingBudget) {
    throw new Error(
      `Discord asked us to wait ${Math.ceil(delay / 1_000)} seconds before searching again. Try joining after that delay.`,
    );
  }
  await sleep(delay);
  return delay;
}

async function performMessageSearch(
  botToken: string,
  guildId: string,
  userId: string,
  since: Date | null,
  options: MessageSearchOptions = {},
): Promise<number> {
  const query = new URLSearchParams({ author_id: userId });
  if (since) query.set("min_id", timestampToSnowflake(since.getTime()));
  const url = `https://discord.com/api/v10/guilds/${guildId}/messages/search?${query.toString()}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const maxAttempts = options.maxAttempts ?? DEFAULT_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("Invalid Discord search retry limit.");
  }

  let totalRetryDelay = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    totalRetryDelay += await waitForCooldown(
      guildId,
      sleep,
      now,
      MAX_TOTAL_RETRY_DELAY_MS - totalRetryDelay,
    );
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bot ${botToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
        throw new Error("Discord message search timed out. Try joining again shortly.");
      }
      throw error;
    }
    const body = (await response.json().catch(() => ({}))) as SearchBody;
    if (response.status === 429) {
      const delay = retryDelay(response, body);
      setCooldown(guildId, delay, body.global === true, now());
      if (attempt + 1 < maxAttempts) continue;
      break;
    }
    if (response.status === 202) {
      if (attempt + 1 < maxAttempts) {
        const delay = retryDelay(response, body);
        if (
          delay > MAX_RETRY_DELAY_MS ||
          totalRetryDelay + delay > MAX_TOTAL_RETRY_DELAY_MS
        ) {
          throw new Error(
            `Discord asked us to wait ${Math.ceil(delay / 1_000)} seconds before searching again. Try joining after that delay.`,
          );
        }
        await sleep(delay);
        totalRetryDelay += delay;
        continue;
      }
      break;
    }
    if (!response.ok) {
      throw new Error(body.message ?? "Discord could not search this server's messages.");
    }
    const total = body.total_results;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
      throw new Error("Discord returned an invalid message-search result.");
    }
    return total;
  }
  throw new Error(
    "Discord is still indexing or rate-limiting message search. Try joining again shortly.",
  );
}

function cacheResult(key: string, value: number, now: number): void {
  if (resultCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = resultCache.keys().next().value as string | undefined;
    if (oldest) resultCache.delete(oldest);
  }
  resultCache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
}

export function searchMessageCount(
  botToken: string,
  guildId: string,
  userId: string,
  since: Date | null,
  options: MessageSearchOptions = {},
): Promise<number> {
  const key = `${guildId}:${userId}:${since?.getTime() ?? "all"}`;
  const now = options.now ?? Date.now;
  const cached = resultCache.get(key);
  if (cached && cached.expiresAt > now()) return Promise.resolve(cached.value);
  if (cached) resultCache.delete(key);
  const existing = inFlightSearches.get(key);
  if (existing) return existing;
  const pending = scheduleSearch(guildId, () =>
    performMessageSearch(botToken, guildId, userId, since, options),
  )
    .then((value) => {
      cacheResult(key, value, now());
      return value;
    })
    .finally(() => {
      if (inFlightSearches.get(key) === pending) inFlightSearches.delete(key);
    });
  inFlightSearches.set(key, pending);
  return pending;
}

export function resetMessageSearchStateForTests(): void {
  if (activeGlobal !== 0 || searchQueue.length !== 0) {
    throw new Error("Cannot reset message-search state while searches are active.");
  }
  inFlightSearches.clear();
  resultCache.clear();
  activeByGuild.clear();
  guildCooldowns.clear();
  globalCooldown = 0;
}
