import { NextResponse } from "next/server";
import { getPublicGiveaway } from "../../../../lib/queries";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const giveaway = await getPublicGiveaway(id, 1, 10_000);
  if (!giveaway) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({
    algorithm: {
      version: "lilac-weighted-v1",
      candidateOrder: "joinedAt ascending, then userId ascending",
      candidateFields: ["userId", "joinedAt", "weight"],
      seed: "SHA256(drand_randomness_bytes || candidate_hash_bytes || UTF8(draw_number))",
      sampling: "SHA-256 counter stream with rejection sampling; weighted without replacement",
    },
    ...giveaway,
  });
}
