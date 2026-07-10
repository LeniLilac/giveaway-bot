import Link from "next/link";
import type { DiscordGuild, SessionUser } from "../lib/auth";
import { avatarUrl } from "../lib/auth";
import { queueGiveawayAction } from "../lib/actions";
import type { AuditEvent, DashboardGiveaway } from "../lib/queries";
import { LocalTime, LocalTimeTitle } from "./local-time";

export function Mark(): React.ReactElement {
  return (
    <span className="mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export function SiteHeader({ session }: { session: SessionUser | null }): React.ReactElement {
  return (
    <header className="site-header">
      <Link className="brand" href="/">
        <Mark />
        <span>Lilac</span>
      </Link>
      <nav aria-label="Primary navigation">
        <Link href="/#proof">How proof works</Link>
        <Link href="/stats">Stats</Link>
        <Link href="/support">Support</Link>
        {session ? (
          <Link className="button button-small" href="/dashboard">
            Dashboard
          </Link>
        ) : (
          <Link className="button button-small" href="/api/auth/login">
            Sign in with Discord
          </Link>
        )}
      </nav>
    </header>
  );
}

export function Footer(): React.ReactElement {
  return (
    <footer className="footer">
      <div>
        <Link className="brand" href="/">
          <Mark />
          <span>Lilac</span>
        </Link>
        <p>Verifiable Discord giveaways, without the ceremony.</p>
      </div>
      <nav aria-label="Legal and support">
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/support">Support</Link>
        <a href="https://github.com/LeniLilac/giveaway-bot">Source</a>
      </nav>
    </footer>
  );
}

export function Status({ value }: { value: string }): React.ReactElement {
  const tone = ["active", "complete", "ended"].includes(value)
    ? "success"
    : ["queued", "awaiting_beacon", "starting", "ending", "drawing"].includes(value)
      ? "pending"
      : ["error", "failed", "deleted"].includes(value)
        ? "danger"
        : "neutral";
  return (
    <span className={`status status-${tone}`}>
      <span aria-hidden="true" />
      {value.replaceAll("_", " ")}
    </span>
  );
}

function guildIcon(guild: DiscordGuild): string | null {
  return guild.icon
    ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=96`
    : null;
}

export function AppShell({
  session,
  guilds,
  activeGuildId,
  children,
}: {
  session: SessionUser;
  guilds: DiscordGuild[];
  activeGuildId?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand sidebar-brand" href="/">
          <Mark />
          <span>Lilac</span>
        </Link>
        <nav aria-label="Dashboard navigation">
          <Link className={!activeGuildId ? "nav-item active" : "nav-item"} href="/dashboard">
            <span className="nav-glyph">⌁</span>
            My giveaways
          </Link>
          <p className="nav-label">Servers</p>
          {guilds.map((guild) => (
            <Link
              className={activeGuildId === guild.id ? "nav-item active" : "nav-item"}
              href={`/dashboard/guild/${guild.id}`}
              key={guild.id}
            >
              {guildIcon(guild) ? (
                <img alt="" height="28" src={guildIcon(guild)!} width="28" />
              ) : (
                <span className="guild-fallback">{guild.name.slice(0, 1)}</span>
              )}
              <span>{guild.name}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-user">
          <img
            alt=""
            height="36"
            src={avatarUrl(session)}
            width="36"
          />
          <span>
            <strong>{session.globalName ?? session.username}</strong>
            <small>@{session.username}</small>
          </span>
        </div>
      </aside>
      <main className="app-main">{children}</main>
    </div>
  );
}

function possibleActions(status: string): Array<"start" | "end" | "reroll" | "delete"> {
  if (status === "queued") return ["start", "delete"];
  if (status === "active") return ["end", "delete"];
  if (status === "ended") return ["reroll", "delete"];
  if (status === "error") return ["delete"];
  return [];
}

export function GiveawayTable({
  giveaways,
  empty,
}: {
  giveaways: DashboardGiveaway[];
  empty: string;
}): React.ReactElement {
  if (giveaways.length === 0) {
    return (
      <div className="empty-state">
        <span aria-hidden="true">/</span>
        <h3>No giveaways here</h3>
        <p>{empty}</p>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Prize</th>
            <th>Status</th>
            <th>Participants</th>
            <th>Timing</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {giveaways.map((giveaway) => (
            <tr key={giveaway.id}>
              <td data-label="Prize">
                <Link className="table-title" href={`/g/${giveaway.id}`}>
                  {giveaway.prize}
                </Link>
                <code>{giveaway.id.slice(0, 8)}</code>
              </td>
              <td data-label="Status">
                <Status value={giveaway.status} />
              </td>
              <td data-label="Participants">
                {giveaway.participantCount.toLocaleString()} / {giveaway.winnerCount} winners
              </td>
              <td data-label="Timing">
                <LocalTime value={(giveaway.endsAt ?? giveaway.scheduledStartAt).toISOString()} />
              </td>
              <td className="table-actions">
                <Link className="button button-quiet button-small" href={`/g/${giveaway.id}`}>
                  Inspect
                </Link>
                {possibleActions(giveaway.status).map((action) => (
                  <form action={queueGiveawayAction} key={action}>
                    <input name="giveawayId" type="hidden" value={giveaway.id} />
                    <input name="action" type="hidden" value={action} />
                    <button
                      className={
                        action === "delete"
                          ? "button button-danger button-small"
                          : "button button-secondary button-small"
                      }
                      type="submit"
                    >
                      {action}
                    </button>
                  </form>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AuditList({ events }: { events: AuditEvent[] }): React.ReactElement {
  if (events.length === 0) return <p className="muted">No audit events yet.</p>;
  return (
    <ol className="audit-list">
      {events.map((event) => (
        <li key={event.id}>
          <span className="audit-node" aria-hidden="true" />
          <div>
            <strong>{event.action.replaceAll("_", " ")}</strong>
            <span>
              {event.actorUserId ? `User ${event.actorUserId}` : "System"} via {event.source}
            </span>
          </div>
          <LocalTime value={event.occurredAt.toISOString()} />
        </li>
      ))}
    </ol>
  );
}

export function ActivityGraph({
  points,
}: {
  points: Array<{ bucket: Date; joins: number; leaves: number }>;
}): React.ReactElement {
  if (points.length === 0) {
    return <p className="muted">Activity appears here after the first entry.</p>;
  }
  const visible = points.slice(-36);
  const maximum = Math.max(...visible.map((point) => Math.max(point.joins, point.leaves)), 1);
  return (
    <div className="activity-graph" role="img" aria-label="Joins and leaves over time">
      <div className="graph-key">
        <span><i className="key-joins" /> Joins</span>
        <span><i className="key-leaves" /> Leaves</span>
      </div>
      <div className="graph-bars">
        {visible.map((point) => (
          <LocalTimeTitle
            className="graph-column"
            key={point.bucket.toISOString()}
            value={point.bucket.toISOString()}
            suffix={`${point.joins} joins, ${point.leaves} leaves`}
          >
            <span
              className="bar joins"
              style={{ height: `${Math.max(2, (point.joins / maximum) * 100)}%` }}
            />
            <span
              className="bar leaves"
              style={{ height: `${Math.max(2, (point.leaves / maximum) * 100)}%` }}
            />
          </LocalTimeTitle>
        ))}
      </div>
      <div className="graph-axis">
        <LocalTime dateOnly value={visible[0]!.bucket.toISOString()} />
        <LocalTime dateOnly value={visible.at(-1)!.bucket.toISOString()} />
      </div>
    </div>
  );
}
