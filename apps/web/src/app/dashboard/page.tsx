import { AppShell, GiveawayTable } from "../../components/ui";
import { canManageGuild, getDiscordGuilds, requireSession } from "../../lib/auth";
import { getUserDashboard } from "../../lib/queries";

export const dynamic = "force-dynamic";

export default async function DashboardPage(): Promise<React.ReactElement> {
  const session = await requireSession("/dashboard");
  const [guilds, dashboard] = await Promise.all([
    getDiscordGuilds(session),
    getUserDashboard(session.id),
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
          <span className="count-label">{dashboard.created.length}</span>
        </div>
        <GiveawayTable
          empty="Create one with /giveaway create in a server where Lilac is installed."
          giveaways={dashboard.created}
        />
      </section>
      <section className="dashboard-section">
        <div className="section-heading">
          <div>
            <h2>My entries</h2>
            <p>Giveaways you joined, including entries you later left.</p>
          </div>
          <span className="count-label">{dashboard.joined.length}</span>
        </div>
        <GiveawayTable
          empty="Join a Lilac giveaway in Discord and it will appear here."
          giveaways={dashboard.joined}
        />
      </section>
    </AppShell>
  );
}
