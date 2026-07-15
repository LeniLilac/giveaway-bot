import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ActivityGraph,
  AuditList,
  Footer,
  SiteHeader,
  Status,
} from "../../../components/ui";
import { LocalTime } from "../../../components/local-time";
import { getSession } from "../../../lib/auth";
import { isUuid, parsePositiveInt32 } from "../../../lib/identifiers";
import {
  PublicEvidenceBusyError,
  publicApiClientKey,
  takePublicApiRateLimit,
} from "../../../lib/public-api-control";
import { getCachedPublicGiveaway } from "../../../lib/public-giveaway";
import { publicOffsetPageCount } from "../../../lib/queries";

export const dynamic = "force-dynamic";

function participantAvatar(userId: string, avatarHash: string | null): string | null {
  if (!avatarHash || !/^\d+$/.test(userId)) return null;
  const extension = avatarHash.startsWith("a_") ? "gif" : "webp";
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${extension}?size=96`;
}

function pageNumber(value: string | undefined, maximum = 2_147_483_647): number {
  if (!value || !/^\d+$/u.test(value)) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : 1;
}

export function generateMetadata(): Metadata {
  return {
    title: "Giveaway evidence",
    description: "Public participants, winners, audit trail, and drand proof.",
  };
}

export default async function PublicGiveawayPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string; draw?: string; winnerPage?: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const rate = takePublicApiRateLimit(publicApiClientKey(await headers()));
  if (!rate.allowed) {
    return (
      <div className="document-page">
        <main className="document">
          <p className="eyebrow">PLEASE WAIT</p>
          <h1>Too many evidence requests</h1>
          <p>Try this public giveaway page again in about a minute.</p>
        </main>
      </div>
    );
  }
  const query = await searchParams;
  const requestedPage = pageNumber(query.page);
  const requestedWinnerPage = pageNumber(query.winnerPage, 21_474_837);
  const requestedDrawNumber = query.draw === undefined ? null : parsePositiveInt32(query.draw);
  if (query.draw !== undefined && requestedDrawNumber === null) notFound();
  const loaded = await Promise.all([
    getSession(),
    getCachedPublicGiveaway(id, {
      participantPage: requestedPage,
      participantPageSize: 100,
      evidencePage: requestedWinnerPage,
      evidencePageSize: 100,
      includeCandidates: false,
      includeExclusions: false,
      ...(requestedWinnerPage > 1
        ? { winnerAfterPosition: (requestedWinnerPage - 1) * 100 }
        : {}),
      ...(requestedDrawNumber === null ? {} : { drawNumber: requestedDrawNumber }),
    }),
  ])
    .then(([session, data]) => ({ session, data }))
    .catch((error: unknown) => {
      if (error instanceof PublicEvidenceBusyError) return null;
      throw error;
    });
  if (!loaded) {
    return (
      <div className="document-page">
        <main className="document">
          <p className="eyebrow">PLEASE WAIT</p>
          <h1>Public evidence is busy</h1>
          <p>Try this giveaway page again in a few seconds.</p>
        </main>
      </div>
    );
  }
  const { session, data } = loaded;
  if (!data) notFound();
  if (
    requestedDrawNumber !== null &&
    data.selectedDrawNumber !== requestedDrawNumber
  ) {
    notFound();
  }
  const { giveaway, participants, participantTotal, draws, audit, activity } = data;
  const page = data.pagination.participants.page;
  const winnerPage = data.pagination.evidence.page;
  const selectedDraw =
    draws.find((draw) => draw.drawNumber === data.selectedDrawNumber) ??
    draws[0] ??
    null;
  const selectedDrawQuery = selectedDraw ? `&draw=${selectedDraw.drawNumber}` : "";
  const winnerPageQuery = winnerPage > 1 ? `&winnerPage=${winnerPage}` : "";
  const pages = publicOffsetPageCount(participantTotal, 100);
  const winnerPages = Math.max(1, Math.ceil((selectedDraw?.winnerTotal ?? 0) / 100));
  const discordUrl = giveaway.messageId
    ? `https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId}`
    : null;

  return (
    <div className="public-page">
      <SiteHeader session={session} />
      <main className="public-main">
        <header className="giveaway-heading">
          <div>
            <div className="heading-meta">
              <Status value={giveaway.status} />
              <code>{giveaway.id}</code>
            </div>
            <h1>{giveaway.prize}</h1>
            <p>
              Hosted by {giveaway.hostUserId ? `Discord user ${giveaway.hostUserId}` : "a deleted user"}.
              Created <LocalTime value={giveaway.createdAt.toISOString()} />.
            </p>
          </div>
          <div className="heading-actions">
            {discordUrl ? (
              <a className="button button-secondary" href={discordUrl}>Open in Discord</a>
            ) : null}
            <a
              className="button button-quiet"
              href={`/api/giveaways/${giveaway.id}${selectedDraw ? `?draw=${selectedDraw.drawNumber}` : ""}`}
            >
              JSON evidence
            </a>
          </div>
        </header>

        {giveaway.status === "deleted" ? (
          <section className="tombstone">
            <span aria-hidden="true">×</span>
            <div>
              <p className="eyebrow">PUBLIC TOMBSTONE</p>
              <h2>This giveaway was deleted.</h2>
              <p>
                The identifier, deletion state, and audit event remain public so an
                operator cannot silently erase the fact that a giveaway existed.
              </p>
            </div>
          </section>
        ) : (
          <>
            <section className="fact-strip" aria-label="Giveaway summary">
              <div><small>Participants</small><strong>{giveaway.participantCount.toLocaleString()}</strong></div>
              <div><small>Initial winners requested</small><strong>{giveaway.winnerCount.toLocaleString()}</strong></div>
              <div><small>Started</small><strong><LocalTime value={giveaway.startedAt?.toISOString() ?? null} /></strong></div>
              <div><small>{giveaway.endedAt ? "Ended" : "Ends"}</small><strong><LocalTime value={(giveaway.endedAt ?? giveaway.endsAt)?.toISOString() ?? null} /></strong></div>
            </section>

            {draws.length > 0 ? (
              <nav className="draw-selector" aria-label="Draw history">
                {[...draws].reverse().map((draw) => (
                  <Link
                    aria-current={draw.id === selectedDraw?.id ? "page" : undefined}
                    href={`?draw=${draw.drawNumber}${page > 1 ? `&page=${page}` : ""}`}
                    key={draw.id}
                  >
                    {draw.drawNumber === 1
                      ? "Draw 1 (original)"
                      : `Draw ${draw.drawNumber} (reroll ${draw.drawNumber - 1})`}
                  </Link>
                ))}
              </nav>
            ) : null}

            <section className="evidence-section proof-section">
              <div className="section-heading public-section-heading">
                <div>
                  <p className="eyebrow">PUBLIC RANDOMNESS</p>
                  <h2>Draw proof</h2>
                  <p>The committed inputs and resulting beacon are shown without requiring sign-in.</p>
                </div>
                {selectedDraw ? <Status value={selectedDraw.status} /> : null}
              </div>
              {selectedDraw ? (
                <>
                  <div className="proof-layout">
                  <dl className="proof-values">
                    <div>
                      <dt>Algorithm</dt>
                      <dd><code>{selectedDraw.proofVersion}</code></dd>
                    </div>
                    <div>
                      <dt>Candidate snapshot SHA-256</dt>
                      <dd><code>{selectedDraw.candidateHash ?? "Pending"}</code></dd>
                    </div>
                    <div>
                      <dt>Winners requested</dt>
                      <dd><strong>{selectedDraw.requestedWinnerCount.toLocaleString()}</strong></dd>
                    </div>
                    <div>
                      <dt>Winners selected</dt>
                      <dd><strong>{selectedDraw.actualWinnerCount?.toLocaleString() ?? "Pending"}</strong></dd>
                    </div>
                    <div>
                      <dt>Drand Quicknet chain</dt>
                      <dd><code>{selectedDraw.drandChainHash}</code></dd>
                    </div>
                    <div>
                      <dt>Committed round</dt>
                      <dd><code>{selectedDraw.drandRound}</code></dd>
                    </div>
                    <div>
                      <dt>Beacon available at</dt>
                      <dd><LocalTime value={selectedDraw.drandBeaconTime.toISOString()} /></dd>
                    </div>
                    <div>
                      <dt>Randomness</dt>
                      <dd><code>{selectedDraw.drandRandomness ?? "Waiting for beacon"}</code></dd>
                    </div>
                    <div>
                      <dt>Signature</dt>
                      <dd><code>{selectedDraw.drandSignature ?? "Waiting for beacon"}</code></dd>
                    </div>
                  </dl>
                  <aside className="verification-note">
                    <span className="verification-number">{selectedDraw.drawNumber.toString().padStart(2, "0")}</span>
                    <h3>Reproduce this draw</h3>
                    <ol>
                      <li>
                        {selectedDraw.proofVersion === "lilac-weighted-v2"
                          ? "Read candidates in published ordinal order and verify ordinals are contiguous from zero."
                          : "Sort candidates by join time, then user ID."}
                      </li>
                      <li>
                        Hash the canonical {selectedDraw.proofVersion === "lilac-weighted-v2" ? "participant ID" : "user ID"}, ISO join time, and weight array.
                      </li>
                      <li>Verify the drand signature and its SHA-256 randomness.</li>
                      <li>Run weighted rejection sampling without replacement.</li>
                    </ol>
                    <a
                      href={`https://api.drand.sh/${selectedDraw.drandChainHash}/public/${selectedDraw.drandRound}`}
                    >
                      Fetch this beacon from drand
                    </a>
                    <a href={`https://api.drand.sh/${selectedDraw.drandChainHash}/info`}>
                      Inspect the pinned Quicknet chain
                    </a>
                  </aside>
                  </div>
                  {selectedDraw.legacyVerificationStatus === "redacted_unverifiable" ? (
                    <p className="muted">
                      This legacy v1 proof contains a privacy-redacted canonical user ID,
                      so the currently published rows cannot reproduce its historical
                      candidate hash.
                    </p>
                  ) : null}
                </>
              ) : (
                <div className="empty-state compact">
                  <h3>No draw committed yet</h3>
                  <p>The participant snapshot appears when this giveaway ends.</p>
                </div>
              )}
            </section>

            <section className="evidence-section">
              <div className="section-heading public-section-heading">
                <div>
                  <p className="eyebrow">RESULT</p>
                  <h2>Winners</h2>
                </div>
              </div>
              {selectedDraw?.winners.length ? (
                <>
                  <ol className="winner-list">
                    {selectedDraw.winners.map((winner) => (
                      <li key={winner.participantId}>
                        <span>{winner.position.toString().padStart(2, "0")}</span>
                        <strong>{winner.username}</strong>
                        <code>{winner.userId}</code>
                      </li>
                    ))}
                  </ol>
                  {winnerPages > 1 ? (
                    <nav className="pagination" aria-label="Winner pages">
                      {winnerPage > 1 ? (
                        <Link href={`?winnerPage=${winnerPage - 1}${selectedDrawQuery}${page > 1 ? `&page=${page}` : ""}`}>
                          Previous winners
                        </Link>
                      ) : <span />}
                      <span>Winner page {winnerPage} of {winnerPages}</span>
                      {winnerPage < winnerPages ? (
                        <Link href={`?winnerPage=${winnerPage + 1}${selectedDrawQuery}${page > 1 ? `&page=${page}` : ""}`}>
                          Next winners
                        </Link>
                      ) : <span />}
                    </nav>
                  ) : null}
                </>
              ) : (
                <p className="muted">Winners have not been selected yet.</p>
              )}
            </section>

            <section className="two-column-evidence">
              <div className="evidence-section">
                <div className="section-heading public-section-heading">
                  <div>
                    <p className="eyebrow">ENTRY ACTIVITY</p>
                    <h2>Joins over time</h2>
                  </div>
                </div>
                <ActivityGraph points={activity} />
              </div>
              <div className="evidence-section requirements-summary">
                <div className="section-heading public-section-heading">
                  <div>
                    <p className="eyebrow">ELIGIBILITY</p>
                    <h2>Requirements</h2>
                  </div>
                </div>
                <dl>
                  <div><dt>Required roles</dt><dd>{giveaway.requiredRoleIds.length ? giveaway.requiredRoleIds.join(", ") : "None"}</dd></div>
                  <div><dt>Role mode</dt><dd>{giveaway.requiredRoleMode ?? "Not applicable"}</dd></div>
                  <div><dt>Required messages</dt><dd>{giveaway.requiredMessages ?? "None"}</dd></div>
                  <div><dt>Message scope</dt><dd>{giveaway.messageScope?.replaceAll("_", " ") ?? "Not applicable"}</dd></div>
                  <div><dt>Bonus roles</dt><dd>{giveaway.bonusRoles.length ? giveaway.bonusRoles.map((role) => `${role.roleId} (+${role.bonusEntries})`).join(", ") : "None"}</dd></div>
                </dl>
              </div>
            </section>

            <section className="evidence-section">
              <div className="section-heading public-section-heading">
                <div>
                  <p className="eyebrow">PUBLIC ENTRY LEDGER</p>
                  <h2>Participants</h2>
                  <p>Username and avatar values are snapshots from the exact join time.</p>
                </div>
                <span className="count-label">{participantTotal.toLocaleString()}</span>
              </div>
              <div className="participant-list">
                {participants.map((participant) => {
                  const image = participantAvatar(participant.userId, participant.avatarHash);
                  return (
                    <div className="participant" key={participant.userId}>
                      {image ? (
                        <img alt="" height="40" loading="lazy" src={image} width="40" />
                      ) : (
                        <span className="avatar-fallback" aria-hidden="true">
                          {participant.username.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <span className="participant-name">
                        <strong>{participant.globalName ?? participant.username}</strong>
                        <code>{participant.userId}</code>
                      </span>
                      <span>
                        <small>Joined</small>
                        <LocalTime value={participant.joinedAt.toISOString()} />
                      </span>
                      <span>
                        <small>Draw status</small>
                        {participant.eligibleAtDraw === null
                          ? "Not evaluated"
                          : participant.eligibleAtDraw
                            ? `Eligible, weight ${participant.drawWeight}`
                            : participant.ineligibleReason?.replaceAll("_", " ") ?? "Excluded"}
                      </span>
                    </div>
                  );
                })}
              </div>
              {pages > 1 ? (
                <nav className="pagination" aria-label="Participant pages">
                  {page > 1 ? <Link href={`?page=${page - 1}${selectedDrawQuery}${winnerPageQuery}`}>Previous</Link> : <span />}
                  <span>Page {page} of {pages}</span>
                  {page < pages ? <Link href={`?page=${page + 1}${selectedDrawQuery}${winnerPageQuery}`}>Next</Link> : <span />}
                </nav>
              ) : null}
            </section>
          </>
        )}

        <section className="evidence-section">
          <div className="section-heading public-section-heading">
            <div>
              <p className="eyebrow">EVENT HISTORY</p>
              <h2>Action log</h2>
            </div>
          </div>
          <AuditList events={audit} />
        </section>
      </main>
      <Footer />
    </div>
  );
}
