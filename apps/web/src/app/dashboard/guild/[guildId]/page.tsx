import { notFound } from "next/navigation";
import {
  AppShell,
  AuditList,
  GiveawayTable,
} from "../../../../components/ui";
import { saveCommandRoles } from "../../../../lib/actions";
import {
  canManageGuild,
  getDiscordGuilds,
  requireSession,
} from "../../../../lib/auth";
import { getGuildDashboard } from "../../../../lib/queries";

export const dynamic = "force-dynamic";

const commands = ["create", "start", "end", "reroll", "delete", "queue", "list"];

export default async function GuildDashboardPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}): Promise<React.ReactElement> {
  const { guildId } = await params;
  const session = await requireSession(`/dashboard/guild/${guildId}`);
  const guilds = await getDiscordGuilds(session);
  const manageableGuilds = guilds.filter(canManageGuild);
  const guild = manageableGuilds.find((candidate) => candidate.id === guildId);
  if (!guild) notFound();
  const dashboard = await getGuildDashboard(guildId);

  return (
    <AppShell activeGuildId={guildId} guilds={manageableGuilds} session={session}>
      <header className="app-header">
        <div>
          <p className="eyebrow">SERVER WORKSPACE</p>
          <h1>{guild.name}</h1>
        </div>
        <span className="capacity">
          <strong>
            {
              dashboard.giveaways.filter((giveaway) =>
                ["queued", "starting", "active", "ending"].includes(giveaway.status),
              ).length
            }
          </strong>
          / 1,000 active or queued
        </span>
      </header>
      <section className="dashboard-section">
        <div className="section-heading">
          <div>
            <h2>Giveaways</h2>
            <p>Every active or queued giveaway, followed by the 250 most recent completed records.</p>
          </div>
          <span className="count-label">{dashboard.giveaways.length}</span>
        </div>
        <GiveawayTable
          empty="Run /giveaway create in this server to start the first one."
          giveaways={dashboard.giveaways}
        />
      </section>
      <section className="dashboard-section settings-section">
        <div className="section-heading">
          <div>
            <h2>Command permissions</h2>
            <p>Server owner, Administrator, and Manage Server always bypass these role lists.</p>
          </div>
        </div>
        <form action={saveCommandRoles} className="settings-form">
          <input name="guildId" type="hidden" value={guildId} />
          {commands.map((command) => (
            <label key={command}>
              <span>
                <strong>/giveaway {command}</strong>
                <small>Discord role IDs, separated by spaces or commas</small>
              </span>
              <input
                defaultValue={(dashboard.commandRoles[command] ?? []).join(", ")}
                name={`roles_${command}`}
                placeholder="123456789012345678"
                spellCheck={false}
              />
            </label>
          ))}
          <button className="button" type="submit">Save permissions</button>
        </form>
      </section>
      <section className="dashboard-section">
        <div className="section-heading">
          <div>
            <h2>Server audit log</h2>
            <p>Operator, participant, and worker actions share one timeline.</p>
          </div>
        </div>
        <AuditList events={dashboard.audit} />
      </section>
    </AppShell>
  );
}
