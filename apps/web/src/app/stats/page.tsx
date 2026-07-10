import { Footer, SiteHeader } from "../../components/ui";
import { getSession } from "../../lib/auth";
import { getPublicStats } from "../../lib/queries";

export const metadata = { title: "Stats" };
export const dynamic = "force-dynamic";

export default async function StatsPage(): Promise<React.ReactElement> {
  const [session, stats] = await Promise.all([getSession(), getPublicStats()]);
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
