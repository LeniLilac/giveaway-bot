export interface RerollExclusion {
  userId: string;
  reason: string;
}

export function canFulfillReroll(
  requestedWinnerCount: number,
  eligibleCandidateCount: number,
): boolean {
  return eligibleCandidateCount >= requestedWinnerCount;
}

export function countExclusionReasons(
  exclusions: RerollExclusion[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const exclusion of exclusions) {
    counts[exclusion.reason] = (counts[exclusion.reason] ?? 0) + 1;
  }
  return counts;
}
