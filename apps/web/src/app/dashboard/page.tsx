import Link from "next/link";
import { AppShell, GiveawayTable } from "../../components/ui";
import { canManageGuild, getDiscordGuilds, requireSession } from "../../lib/auth";
import { getUserDashboard } from "../../lib/queries";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 50;

function parsePage(value: string | undefined): number {
  return Math.max(1, Number.parseInt(value ?? "1", 10) || 1);
}

function DashboardPager({
  current,
  total,
  target,
  createdPage,
  joinedPage,
}: {
  current: number;
  total: number;
  target: "created" | "joined";
  createdPage: number;
  joinedPage: number;
}): React.ReactElement | null {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return null;
  const href = (next: number): string => {
    const params = new URLSearchParams();
    const created = target === "created" ? next : createdPage;
    const joined = target === "joined" ? next : joinedPage;
    if (created > 1) params.set("createdPage", String(created));
    if (joined > 1) params.set("joinedPage", String(joined));
    const query = params.toString();
    return query ? `/dashboard?${query}` : "/dashboard";
  };
  return (
    <nav className="pagination" aria-label={`${target} giveaway pages`}>
      {current > 1 ? <Link href={href(current - 1)}>Previous</Link> : <span />}
      <span>Page {current} of {pages}</span>
      {current < pages ? <Link href={href(current + 1)}>Next</Link> : <span />}
    </nav>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ createdPage?: string; joinedPage?: string }>;
}): Promise<React.ReactElement> {
  const query = await searchParams;
  const createdPage = parsePage(query.createdPage);
  const joinedPage = parsePage(query.joinedPage);
  const session = await requireSession("/dashboard");
  const [guilds, dashboard] = await Promise.all([
    getDiscordGuilds(session),
    getUserDashboard(session.id, createdPage, joinedPage, PAGE_SIZE),
  ]);
  const manageableGuilds = guilds.filter(canManageGuild);
  return (
    <AppShell guilds={manageableGuilds} session={session}>
      <header className="app-header">
        <div>
          <p className="eyebrow">PERSONAL DASHBOARD</p>
          <h1>My giveaways</h1>
        </div>
        <a className="button button-secondary" href="/api/auth/login?returnTo=/dashboard">
          Refresh Discord access
        </a>
      </header>
      <section className="dashboard-section">
        <div className="section-heading">
          <div>
            <h2>Created by me</h2>
            <p>Lifecycle controls remain available here and in Discord.</p>
          </div>
          <span className="count-label">{dashboard.createdTotal}</span>
        </div>
        <GiveawayTable
          empty="Create one with /giveaway create in a server where Lilac is installed."
          giveaways={dashboard.created}
        />
        <DashboardPager
          createdPage={createdPage}
          current={createdPage}
          joinedPage={joinedPage}
          target="created"
          total={dashboard.createdTotal}
        />
      </section>
      <section className="dashboard-section">
        <div className="section-heading">
          <div>
            <h2>My entries</h2>
            <p>Giveaways you joined, including entries you later left.</p>
          </div>
          <span className="count-label">{dashboard.joinedTotal}</span>
        </div>
        <GiveawayTable
          empty="Join a Lilac giveaway in Discord and it will appear here."
          giveaways={dashboard.joined}
        />
        <DashboardPager
          createdPage={createdPage}
          current={joinedPage}
          joinedPage={joinedPage}
          target="joined"
          total={dashboard.joinedTotal}
        />
      </section>
    </AppShell>
  );
}
