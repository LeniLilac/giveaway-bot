import { Footer, SiteHeader } from "../../components/ui";
import { getSession } from "../../lib/auth";

export const metadata = { title: "Terms" };
export const dynamic = "force-dynamic";

export default async function TermsPage(): Promise<React.ReactElement> {
  const session = await getSession();
  return (
    <div className="document-page">
      <SiteHeader session={session} />
      <main className="document">
        <p className="eyebrow">POLICY</p>
        <h1>Terms of use</h1>
        <p className="document-lede">Lilac is an operational tool, not an escrow, marketplace, or prize guarantor.</p>
        <h2>Host responsibility</h2>
        <p>Giveaway hosts are responsible for lawful rules, prize delivery, eligibility disclosures, and Discord policy compliance.</p>
        <h2>Availability</h2>
        <p>The service is provided without a guarantee of uninterrupted availability. Failed lifecycle jobs are retried and surfaced as errors.</p>
        <h2>Random selection</h2>
        <p>Lilac publishes its candidate commitment, drand input, and deterministic algorithm. Verification demonstrates how the recorded winner was computed; it does not validate a host&apos;s prize or external conduct.</p>
        <h2>Abuse</h2>
        <p>Servers using Lilac for fraud, harassment, unlawful promotions, or Discord policy violations may be denied service.</p>
      </main>
      <Footer />
    </div>
  );
}
