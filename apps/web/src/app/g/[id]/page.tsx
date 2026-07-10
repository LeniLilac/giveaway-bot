import type { Metadata } from "next";
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
import { getPublicGiveaway } from "../../../lib/queries";

export const dynamic = "force-dynamic";

function participantAvatar(userId: string, avatarHash: string | null): string | null {
  if (!avatarHash || !/^\d+$/.test(userId)) return null;
  const extension = avatarHash.startsWith("a_") ? "gif" : "webp";
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${extension}?size=96`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const data = await getPublicGiveaway(id, 1, 1);
  return data
    ? {
        title: data.giveaway.prize,
        description: `Public participants, winners, audit trail, and drand proof for ${data.giveaway.prize}.`,
      }
    : { title: "Giveaway not found" };
}

export default async function PublicGiveawayPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const query = await searchParams;
  const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
  const [session, data] = await Promise.all([
    getSession(),
    getPublicGiveaway(id, page, 100),
  ]);
  if (!data) notFound();
  const { giveaway, participants, participantTotal, draws, audit, activity } = data;
  const latestDraw = draws[0] ?? null;
  const pages = Math.max(1, Math.ceil(participantTotal / 100));
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
            <a className="button button-quiet" href={`/api/giveaways/${giveaway.id}`}>
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
              <div><small>Winners requested</small><strong>{giveaway.winnerCount.toLocaleString()}</strong></div>
              <div><small>Started</small><strong><LocalTime value={giveaway.startedAt?.toISOString() ?? null} /></strong></div>
              <div><small>{giveaway.endedAt ? "Ended" : "Ends"}</small><strong><LocalTime value={(giveaway.endedAt ?? giveaway.endsAt)?.toISOString() ?? null} /></strong></div>
            </section>

            <section className="evidence-section proof-section">
              <div className="section-heading public-section-heading">
                <div>
                  <p className="eyebrow">PUBLIC RANDOMNESS</p>
                  <h2>Draw proof</h2>
                  <p>The committed inputs and resulting beacon are shown without requiring sign-in.</p>
                </div>
                {latestDraw ? <Status value={latestDraw.status} /> : null}
              </div>
              {latestDraw ? (
                <div className="proof-layout">
                  <dl className="proof-values">
                    <div>
                      <dt>Algorithm</dt>
                      <dd><code>lilac-weighted-v1</code></dd>
                    </div>
                    <div>
                      <dt>Candidate snapshot SHA-256</dt>
                      <dd><code>{latestDraw.candidateHash ?? "Pending"}</code></dd>
                    </div>
                    <div>
                      <dt>Drand Quicknet chain</dt>
                      <dd><code>{latestDraw.drandChainHash}</code></dd>
                    </div>
                    <div>
                      <dt>Committed round</dt>
                      <dd><code>{latestDraw.drandRound}</code></dd>
                    </div>
                    <div>
                      <dt>Beacon available at</dt>
                      <dd><LocalTime value={latestDraw.drandBeaconTime.toISOString()} /></dd>
                    </div>
                    <div>
                      <dt>Randomness</dt>
                      <dd><code>{latestDraw.drandRandomness ?? "Waiting for beacon"}</code></dd>
                    </div>
                    <div>
                      <dt>Signature</dt>
                      <dd><code>{latestDraw.drandSignature ?? "Waiting for beacon"}</code></dd>
                    </div>
                  </dl>
                  <aside className="verification-note">
                    <span className="verification-number">{latestDraw.drawNumber.toString().padStart(2, "0")}</span>
                    <h3>Reproduce this draw</h3>
                    <ol>
                      <li>Sort candidates by join time, then user ID.</li>
                      <li>Hash the canonical user ID, ISO join time, and weight array.</li>
                      <li>Verify the drand signature and its SHA-256 randomness.</li>
                      <li>Run weighted rejection sampling without replacement.</li>
                    </ol>
                    <a
                      href={`https://api.drand.sh/${latestDraw.drandChainHash}/public/${latestDraw.drandRound}`}
                    >
                      Fetch this beacon from drand
                    </a>
                    <a href={`https://api.drand.sh/${latestDraw.drandChainHash}/info`}>
                      Inspect the pinned Quicknet chain
                    </a>
                  </aside>
                </div>
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
              {latestDraw?.winners.length ? (
                <ol className="winner-list">
                  {latestDraw.winners.map((winner) => (
                    <li key={winner.userId}>
                      <span>{winner.position.toString().padStart(2, "0")}</span>
                      <strong>{winner.username}</strong>
                      <code>{winner.userId}</code>
                    </li>
                  ))}
                </ol>
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
                  {page > 1 ? <Link href={`?page=${page - 1}`}>Previous</Link> : <span />}
                  <span>Page {page} of {pages}</span>
                  {page < pages ? <Link href={`?page=${page + 1}`}>Next</Link> : <span />}
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
