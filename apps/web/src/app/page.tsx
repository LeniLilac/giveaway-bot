import Link from "next/link";
import { Footer, SiteHeader } from "../components/ui";
import { getSession } from "../lib/auth";

export const dynamic = "force-dynamic";

export default async function HomePage(): Promise<React.ReactElement> {
  const session = await getSession();
  const applicationId = process.env.DISCORD_APPLICATION_ID ?? "";
  const invite = new URL("https://discord.com/oauth2/authorize");
  invite.search = new URLSearchParams({
    client_id: applicationId,
    permissions: "268520448",
    scope: "bot applications.commands",
  }).toString();

  return (
    <div className="marketing">
      <SiteHeader session={session} />
      <main>
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow"><span /> PUBLIC RANDOMNESS, PLAIN EVIDENCE</p>
            <h1>A giveaway should not ask you to trust the picker.</h1>
            <p className="hero-lede">
              Lilac commits every eligible entry before a future drand beacon exists.
              Anyone can inspect the snapshot, beacon, algorithm, and winners.
            </p>
            <div className="hero-actions">
              <a className="button button-inverse" href={invite.toString()}>
                Add Lilac to Discord
              </a>
              <Link className="button button-ghost-inverse" href="#proof">
                Follow a draw
              </Link>
            </div>
            <p className="hero-note">Up to 1,000 active and queued giveaways per server.</p>
          </div>
          <div className="hero-proof" aria-label="Example proof record">
            <div className="proof-ticket-head">
              <span className="live-dot" /> DRAW VERIFIED
              <code>#04</code>
            </div>
            <div className="ticket-prize">
              <small>PRIZE</small>
              <strong>Community art tablet</strong>
            </div>
            <dl>
              <div><dt>Snapshot</dt><dd>8fb2c1…19a7</dd></div>
              <div><dt>Drand round</dt><dd>32,946,081</dd></div>
              <div><dt>Candidates</dt><dd>2,418</dd></div>
              <div><dt>Selected</dt><dd>@paperfox</dd></div>
            </dl>
            <div className="ticket-seal">
              <span>Inputs published</span>
              <span>Algorithm fixed</span>
              <span>Result reproducible</span>
            </div>
          </div>
        </section>

        <section className="proof-walkthrough" id="proof">
          <div className="section-intro">
            <p className="eyebrow">HOW ONE DRAW BECOMES CHECKABLE</p>
            <h2>Commit first. Learn the randomness later.</h2>
            <p>
              The participant set is frozen and hashed before Lilac requests a future
              beacon. Neither the host nor Lilac knows that randomness at commitment time.
            </p>
          </div>
          <ol className="proof-steps">
            <li>
              <span>01</span>
              <div>
                <h3>Freeze eligibility</h3>
                <p>Roles are checked again. Previous reroll winners are excluded. Bonus weights add together.</p>
              </div>
              <code>candidate_hash</code>
            </li>
            <li>
              <span>02</span>
              <div>
                <h3>Commit a future round</h3>
                <p>The snapshot hash and a Quicknet round at least 15 seconds ahead are published in Discord.</p>
              </div>
              <code>drand_round</code>
            </li>
            <li>
              <span>03</span>
              <div>
                <h3>Select deterministically</h3>
                <p>Rejection sampling maps the beacon to weighted entries without modulo bias or replacement.</p>
              </div>
              <code>lilac-weighted-v2</code>
            </li>
          </ol>
        </section>

        <section className="command-section">
          <div>
            <p className="eyebrow">ONE COMMAND, EXPLICIT RULES</p>
            <h2>Complex entry rules without a configuration maze.</h2>
          </div>
          <div className="command-line" aria-label="Example Discord command">
            <span>/giveaway create</span>
            <code>prize: Nitro</code>
            <code>duration: 1d3h</code>
            <code>winners: 4</code>
            <code>required_roles: @Member</code>
            <code>role_bonus_entries: @Booster:2</code>
          </div>
          <div className="feature-ribbon">
            <p><strong>Schedule freely.</strong> Relative times, combined units, or Unix timestamps.</p>
            <p><strong>Operate anywhere.</strong> Start, end, reroll, and delete from Discord or the dashboard.</p>
            <p><strong>Audit everything.</strong> Exact join times, leaves, draws, exclusions, and operator actions.</p>
          </div>
        </section>

        <section className="final-cta">
          <p className="eyebrow">READY FOR THE NEXT DROP</p>
          <h2>Run the giveaway. Publish the receipts.</h2>
          <a className="button" href={invite.toString()}>Add Lilac to your server</a>
        </section>
      </main>
      <Footer />
    </div>
  );
}
