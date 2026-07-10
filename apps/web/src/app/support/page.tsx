import { Footer, SiteHeader } from "../../components/ui";
import { getSession } from "../../lib/auth";

export const metadata = { title: "Support" };
export const dynamic = "force-dynamic";

export default async function SupportPage(): Promise<React.ReactElement> {
  const session = await getSession();
  return (
    <div className="document-page">
      <SiteHeader session={session} />
      <main className="document">
        <p className="eyebrow">HELP</p>
        <h1>Support</h1>
        <p className="document-lede">Include the giveaway ID, server ID, and exact action that failed.</p>
        <div className="support-route">
          <span>01</span>
          <div><h2>Inspect the public page</h2><p>Job, draw, exclusion, and error state often explains the issue without private access.</p></div>
        </div>
        <div className="support-route">
          <span>02</span>
          <div><h2>Check bot permissions</h2><p>Lilac needs View Channel, Send Messages, Read Message History, and Manage Roles for configured prize roles.</p></div>
        </div>
        <div className="support-route">
          <span>03</span>
          <div><h2>Contact support</h2><p><a href="mailto:lilithlilac000@gmail.com">lilithlilac000@gmail.com</a></p></div>
        </div>
        <p>Source and issue tracking are available at <a href="https://github.com/LeniLilac/giveaway-bot">github.com/LeniLilac/giveaway-bot</a>.</p>
      </main>
      <Footer />
    </div>
  );
}
