import { Footer, SiteHeader } from "../../components/ui";
import { requestDataDeletion } from "../../lib/actions";
import { getSession } from "../../lib/auth";

export const metadata = { title: "Privacy" };
export const dynamic = "force-dynamic";

export default async function PrivacyPage({
  searchParams,
}: {
  searchParams: Promise<{ deletion?: string }>;
}): Promise<React.ReactElement> {
  const [session, query] = await Promise.all([getSession(), searchParams]);
  return (
    <div className="document-page">
      <SiteHeader session={session} />
      <main className="document">
        <p className="eyebrow">POLICY</p>
        <h1>Privacy</h1>
        {query.deletion === "requested" ? (
          <p className="notice success">Your deletion request was queued and your session was closed.</p>
        ) : null}
        {query.deletion === "active" ? (
          <p className="notice warning">
            Sign-in was not restored because its authorization began before data
            deletion finished. Once deletion is complete, start sign-in again and
            approve Discord’s fresh consent prompt.
          </p>
        ) : null}
        <p className="document-lede">
          Lilac stores only the Discord data needed to run, operate, and publicly audit giveaways.
        </p>
        <h2>Public giveaway records</h2>
        <p>
          Entry records include Discord user ID, username, global name, avatar hash, exact join
          and leave time, eligibility, draw weight, and winner status. Public giveaway pages do
          not require an account.
        </p>
        <h2>Dashboard accounts</h2>
        <p>
          Discord OAuth grants identify, guilds, and guilds.members.read scopes so Lilac can
          verify live dashboard permissions and configured command roles. Access and refresh
          tokens are encrypted at rest. Browser sessions are represented by a random, HTTP-only
          cookie whose hash is stored.
        </p>
        <h2>Retention and deletion</h2>
        <p>
          Records are retained indefinitely by default so published audit trails remain useful.
          A deletion request pseudonymizes your public giveaway identity and removes OAuth,
          consent, session, username, global-name, and avatar data. Existing cryptographic
          commitments remain marked as historical evidence.
        </p>
        <h2>Contact</h2>
        <p>Email privacy questions to <a href="mailto:lilithlilac000@gmail.com">lilithlilac000@gmail.com</a>.</p>
        {session ? (
          <form action={requestDataDeletion} className="danger-zone">
            <div>
              <h2>Delete my Lilac data</h2>
              <p>This signs you out immediately and queues irreversible pseudonymization.</p>
            </div>
            <button className="button button-danger" type="submit">Request deletion</button>
          </form>
        ) : null}
      </main>
      <Footer />
    </div>
  );
}
