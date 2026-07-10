import Link from "next/link";
import { Mark } from "../components/ui";

export default function NotFound(): React.ReactElement {
  return (
    <main className="not-found">
      <Link className="brand" href="/"><Mark /><span>Lilac</span></Link>
      <p className="eyebrow">404</p>
      <h1>No giveaway lives at this address.</h1>
      <p>Check the public ID or return to the Lilac landing page.</p>
      <Link className="button" href="/">Return home</Link>
    </main>
  );
}
