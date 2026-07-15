import { headers } from "next/headers";
import { Footer, SiteHeader } from "../../components/ui";
import { getSession } from "../../lib/auth";
import {
  publicApiClientKey,
  takePublicApiRateLimit,
} from "../../lib/public-api-control";
import { getCachedPublicStats } from "../../lib/public-stats";

export const metadata = { title: "Stats" };
export const dynamic = "force-dynamic";

export default async function StatsPage(): Promise<React.ReactElement> {
  const rate = takePublicApiRateLimit(publicApiClientKey(await headers()));
  if (!rate.allowed) {
    return (
      <div className="document-page">
        <main className="document">
          <p className="eyebrow">PLEASE WAIT</p>
          <h1>Too many statistics requests</h1>
          <p>Try this page again in about a minute.</p>
        </main>
      </div>
    );
  }
  const [session, stats] = await Promise.all([getSession(), getCachedPublicStats()]);
  const metrics = [
    ["Servers", stats.servers],
    ["Giveaways created", stats.giveaways],
    ["Live or queued", stats.liveGiveaways],
    ["Giveaways completed", stats.completedGiveaways],
    ["Entry records", stats.entryRecords],
    ["Verified draws", stats.completedDraws],
    ["Winners selected", stats.winners],
  ] as const;

  return (
    <div className="public-page">
      <SiteHeader session={session} />
      <main className="public-main">
        <header className="giveaway-heading">
          <div>
            <p className="eyebrow">PUBLIC SERVICE TOTALS</p>
            <h1>Lilac by the numbers</h1>
            <p>Live totals derived from the same PostgreSQL records used by Discord and public proofs.</p>
          </div>
        </header>
        <section className="evidence-section">
          <div className="section-heading public-section-heading">
            <div>
              <p className="eyebrow">CURRENT SNAPSHOT</p>
              <h2>Operational activity</h2>
            </div>
          </div>
          <div className="fact-strip" aria-label="Lilac service statistics">
            {metrics.map(([label, value]) => (
              <div key={label}>
                <small>{label}</small>
                <strong>{value.toLocaleString()}</strong>
              </div>
            ))}
          </div>
          <p className="muted">
            Deleted giveaway tombstones remain included in the historical giveaway total. Entry records
            count one current record per Discord user and giveaway, while join and leave events remain in
            the audit ledger.
          </p>
        </section>
      </main>
      <Footer />
    </div>
  );
}
