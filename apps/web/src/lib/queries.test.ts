import { describe, expect, it } from "vitest";
import {
  mapGiveaway,
  mapSelectedDrawParticipant,
  publicOffsetPageCount,
  selectedDrawProofFields,
  type PublicDraw,
} from "./queries";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    guild_id: "100000000000000001",
    channel_id: "100000000000000002",
    message_id: null,
    creator_user_id: "100000000000000003",
    host_user_id: "100000000000000003",
    prize: "Prize",
    winner_count: 1,
    duration_seconds: 60,
    status: "ending",
    scheduled_start_at: "2026-07-15T00:00:00.000Z",
    started_at: "2026-07-15T00:00:00.000Z",
    ends_at: "2026-07-15T00:01:00.000Z",
    ended_at: "2026-07-15T00:01:00.000Z",
    participant_count: 1,
    required_role_mode: null,
    required_messages: null,
    message_scope: null,
    required_role_ids: [],
    prize_role_ids: [],
    bonus_roles: [],
    snapshot_hash: "unpublished-new-hash",
    drand_chain_hash: "unpublished-new-chain",
    drand_round: "9",
    drand_signature: "stale-previous-signature",
    drand_randomness: "stale-previous-randomness",
    published_draw_id: "22222222-2222-4222-8222-222222222222",
    published_candidate_hash: "published-hash",
    published_drand_chain_hash: "published-chain",
    published_drand_round: "8",
    published_drand_signature: null,
    published_drand_randomness: null,
    deleted_at: null,
    created_at: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("public giveaway proof projection", () => {
  it("does not advertise offset pages beyond the query cap", () => {
    expect(publicOffsetPageCount(250, 100)).toBe(3);
    expect(publicOffsetPageCount(1_000_000, 100)).toBe(1_001);
  });

  it("sources top-level proof fields from the latest published draw", () => {
    const giveaway = mapGiveaway(row());
    expect(giveaway.snapshotHash).toBe("published-hash");
    expect(giveaway.drandChainHash).toBe("published-chain");
    expect(giveaway.drandRound).toBe("8");
    expect(giveaway.drandSignature).toBeNull();
    expect(giveaway.drandRandomness).toBeNull();
  });

  it("hides every proof field when no draw commitment is published", () => {
    const giveaway = mapGiveaway(row({ published_draw_id: null }));
    expect(giveaway.snapshotHash).toBeNull();
    expect(giveaway.drandChainHash).toBeNull();
    expect(giveaway.drandRound).toBeNull();
    expect(giveaway.drandSignature).toBeNull();
    expect(giveaway.drandRandomness).toBeNull();
  });

  it("projects compatibility proof fields from the selected historical draw", () => {
    const fields = selectedDrawProofFields({
      candidateHash: "historical-hash",
      drandChainHash: "historical-chain",
      drandRound: "7",
      drandSignature: "historical-signature",
      drandRandomness: "historical-randomness",
    } as PublicDraw);
    expect(fields).toEqual({
      snapshotHash: "historical-hash",
      drandChainHash: "historical-chain",
      drandRound: "7",
      drandSignature: "historical-signature",
      drandRandomness: "historical-randomness",
    });
  });

  it("projects participant eligibility from the selected draw, not mutable entry state", () => {
    const participant = mapSelectedDrawParticipant({
      user_id: "100000000000000001",
      username: "member",
      global_name: null,
      avatar_hash: null,
      joined_at: "2026-07-15T00:00:00.000Z",
      left_at: null,
      eligible_at_draw: false,
      draw_weight: null,
      ineligible_reason: "latest_draw_exclusion",
      selected_eligible_at_draw: true,
      selected_draw_weight: 4,
      selected_ineligible_reason: null,
    });

    expect(participant.eligibleAtDraw).toBe(true);
    expect(participant.drawWeight).toBe(4);
    expect(participant.ineligibleReason).toBeNull();
  });
});
