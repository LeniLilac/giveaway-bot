import { getCachedPublicEvidence } from "./public-api-control";
import { getPublicGiveaway } from "./queries";
import type { PublicGiveawayQuery } from "./queries";

export function getCachedPublicGiveaway(
  id: string,
  options: PublicGiveawayQuery = {},
): ReturnType<typeof getPublicGiveaway> {
  const key = JSON.stringify([
    "public-giveaway-v2",
    id,
    options.participantPage ?? 1,
    options.participantPageSize ?? 100,
    options.drawNumber ?? null,
    options.evidencePage ?? 1,
    options.evidencePageSize ?? 100,
    options.includeCandidates ?? true,
    options.includeExclusions ?? true,
    options.participantAfter ?? null,
    options.candidateAfterOrdinal ?? null,
    options.exclusionAfterUserId ?? null,
    options.winnerAfterPosition ?? null,
  ]);
  return getCachedPublicEvidence(key, () => getPublicGiveaway(id, options));
}
