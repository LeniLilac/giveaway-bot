import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  parseBoundedPositiveInteger,
  PublicEvidenceBusyError,
  publicApiClientKey,
  takePublicApiRateLimit,
} from "../../../../lib/public-api-control";
import { getCachedPublicGiveaway } from "../../../../lib/public-giveaway";
import { selectedDrawProofFields } from "../../../../lib/queries";
import {
  isUuid,
  parseNonNegativeInt32,
  parsePositiveInt32,
} from "../../../../lib/identifiers";

export const dynamic = "force-dynamic";

function optionalCursor(value: string | null, maximumLength = 128): string | undefined {
  return value && value.length <= maximumLength && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const rate = takePublicApiRateLimit(publicApiClientKey(request.headers));
  const rateHeaders = {
    "X-RateLimit-Limit": String(rate.limit),
    "X-RateLimit-Remaining": String(rate.remaining),
    "X-RateLimit-Reset": String(Math.ceil(rate.resetAt / 1000)),
  };
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: {
          ...rateHeaders,
          "Retry-After": String(Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))),
        },
      },
    );
  }

  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: rateHeaders });
  }
  const url = new URL(request.url);
  const participantPageSize = parseBoundedPositiveInteger(
    url.searchParams.get("participant_page_size"),
    100,
    250,
  );
  const evidencePageSize = parseBoundedPositiveInteger(
    url.searchParams.get("evidence_page_size"),
    100,
    250,
  );
  const rawDrawNumber = url.searchParams.get("draw");
  const drawNumber = rawDrawNumber === null ? undefined : parsePositiveInt32(rawDrawNumber);
  const participantAfterJoinedAt = optionalCursor(
    url.searchParams.get("participant_after_joined_at"),
    64,
  );
  const participantAfterUserId = optionalCursor(
    url.searchParams.get("participant_after_user_id"),
  );
  const participantAfter =
    participantAfterJoinedAt &&
    participantAfterUserId &&
    Number.isFinite(new Date(participantAfterJoinedAt).getTime())
      ? { joinedAt: participantAfterJoinedAt, userId: participantAfterUserId }
      : undefined;
  const rawCandidateAfterOrdinal = url.searchParams.get("candidate_after_ordinal");
  const candidateAfterOrdinal = parseNonNegativeInt32(
    rawCandidateAfterOrdinal,
  );
  const exclusionAfterUserId = optionalCursor(
    url.searchParams.get("exclusion_after_user_id"),
  );
  const rawWinnerAfterPosition = url.searchParams.get("winner_after_position");
  const winnerAfterPosition = parseNonNegativeInt32(
    rawWinnerAfterPosition,
  );
  const hasMalformedParticipantCursor =
    (url.searchParams.has("participant_after_joined_at") ||
      url.searchParams.has("participant_after_user_id")) &&
    participantAfter === undefined;
  if (
    (rawDrawNumber !== null && drawNumber === null) ||
    (rawCandidateAfterOrdinal !== null && candidateAfterOrdinal === null) ||
    (rawWinnerAfterPosition !== null && winnerAfterPosition === null) ||
    hasMalformedParticipantCursor ||
    (url.searchParams.has("exclusion_after_user_id") && exclusionAfterUserId === undefined)
  ) {
    return NextResponse.json(
      { error: "invalid_pagination" },
      { status: 400, headers: rateHeaders },
    );
  }
  let giveaway;
  try {
    giveaway = await getCachedPublicGiveaway(id, {
      participantPageSize,
      evidencePageSize,
      ...(drawNumber == null ? {} : { drawNumber }),
      ...(participantAfter === undefined ? {} : { participantAfter }),
      ...(candidateAfterOrdinal == null ? {} : { candidateAfterOrdinal }),
      ...(exclusionAfterUserId === undefined ? {} : { exclusionAfterUserId }),
      ...(winnerAfterPosition == null ? {} : { winnerAfterPosition }),
    });
  } catch (error) {
    if (!(error instanceof PublicEvidenceBusyError)) throw error;
    return NextResponse.json(
      { error: "evidence_busy" },
      { status: 503, headers: { ...rateHeaders, "Retry-After": "5" } },
    );
  }
  if (!giveaway) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: rateHeaders });
  }
  if (drawNumber != null && giveaway.selectedDrawNumber !== drawNumber) {
    return NextResponse.json(
      { error: "draw_not_found" },
      { status: 404, headers: rateHeaders },
    );
  }
  const selectedDraw = giveaway.draws.find(
    (draw) => draw.drawNumber === giveaway.selectedDrawNumber,
  );
  const proofVersion = selectedDraw?.proofVersion ?? "lilac-weighted-v2";
  const proofFields = selectedDrawProofFields(selectedDraw);
  const body = {
    algorithm: {
      version: proofVersion,
      candidateOrder:
        proofVersion === "lilac-weighted-v2"
          ? "ordinal ascending; ordinal was assigned from joinedAt ascending, then original Discord userId ascending"
          : "joinedAt ascending, then userId ascending",
      candidateFields:
        proofVersion === "lilac-weighted-v2"
          ? ["participantId", "joinedAt", "weight"]
          : ["userId", "joinedAt", "weight"],
      orderingMetadata:
        proofVersion === "lilac-weighted-v2"
          ? "Validate contiguous ordinals beginning at zero; ordinal is not serialized into the canonical candidate object."
          : null,
      seed: "SHA256(drand_randomness_bytes || candidate_hash_bytes || UTF8(draw_number))",
      sampling: "SHA-256 counter stream with rejection sampling; weighted without replacement",
    },
    ...giveaway,
    giveaway: { ...giveaway.giveaway, ...proofFields },
    ...proofFields,
  };
  const serialized = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(serialized).digest("base64url")}"`;
  const responseHeaders = {
    ...rateHeaders,
    "Cache-Control": "no-store, max-age=0",
    ETag: etag,
  };
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: responseHeaders });
  }
  return new NextResponse(serialized, {
    status: 200,
    headers: { ...responseHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}
