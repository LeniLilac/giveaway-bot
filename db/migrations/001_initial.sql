CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE guild_settings (
    guild_id text PRIMARY KEY,
    guild_name text,
    guild_icon text,
    active_limit integer NOT NULL DEFAULT 1000 CHECK (active_limit BETWEEN 1 AND 1000),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE guild_command_roles (
    guild_id text NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
    command text NOT NULL CHECK (command IN ('create', 'start', 'end', 'reroll', 'delete', 'queue', 'list')),
    role_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, command, role_id)
);

CREATE TABLE privacy_consents (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    policy_version text NOT NULL,
    consented_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    PRIMARY KEY (guild_id, user_id, policy_version)
);

CREATE TABLE giveaway_drafts (
    id uuid PRIMARY KEY,
    guild_id text NOT NULL,
    creator_user_id text NOT NULL,
    channel_id text NOT NULL,
    payload jsonb NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'consumed', 'expired', 'cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
);
CREATE INDEX giveaway_drafts_owner_idx
    ON giveaway_drafts(guild_id, creator_user_id, state, created_at DESC);

CREATE TABLE giveaways (
    id uuid PRIMARY KEY,
    guild_id text NOT NULL,
    channel_id text NOT NULL,
    message_id text,
    creator_user_id text,
    host_user_id text,
    prize text NOT NULL,
    winner_count bigint NOT NULL CHECK (winner_count > 0),
    duration_seconds bigint NOT NULL CHECK (duration_seconds > 0),
    scheduled_start_at timestamptz NOT NULL,
    started_at timestamptz,
    ends_at timestamptz,
    ended_at timestamptz,
    status text NOT NULL CHECK (status IN ('queued', 'starting', 'active', 'ending', 'ended', 'deleted', 'error')),
    required_role_mode text CHECK (required_role_mode IN ('all', 'one')),
    required_messages integer CHECK (required_messages IS NULL OR required_messages >= 0),
    message_scope text CHECK (message_scope IN ('all_time', 'since_start')),
    participant_count integer NOT NULL DEFAULT 0 CHECK (participant_count >= 0),
    snapshot_hash text,
    drand_chain_hash text,
    drand_round bigint,
    drand_signature text,
    drand_randomness text,
    drand_beacon jsonb,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE (guild_id, message_id)
);
CREATE INDEX giveaways_guild_status_idx ON giveaways(guild_id, status, scheduled_start_at);
CREATE INDEX giveaways_creator_idx ON giveaways(creator_user_id, created_at DESC);
CREATE INDEX giveaways_public_idx ON giveaways(id) WHERE status <> 'deleted';

CREATE TABLE giveaway_required_roles (
    giveaway_id uuid NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
    role_id text NOT NULL,
    PRIMARY KEY (giveaway_id, role_id)
);

CREATE TABLE giveaway_prize_roles (
    giveaway_id uuid NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
    role_id text NOT NULL,
    PRIMARY KEY (giveaway_id, role_id)
);

CREATE TABLE giveaway_bonus_roles (
    giveaway_id uuid NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
    role_id text NOT NULL,
    bonus_entries integer NOT NULL CHECK (bonus_entries > 0),
    PRIMARY KEY (giveaway_id, role_id)
);

CREATE TABLE entries (
    giveaway_id uuid NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    username text NOT NULL,
    global_name text,
    avatar_hash text,
    joined_at timestamptz NOT NULL DEFAULT now(),
    left_at timestamptz,
    eligible_at_draw boolean,
    draw_weight integer,
    ineligible_reason text,
    PRIMARY KEY (giveaway_id, user_id)
);
CREATE INDEX entries_user_idx ON entries(user_id, joined_at DESC);
CREATE INDEX entries_active_idx ON entries(giveaway_id, joined_at) WHERE left_at IS NULL;

CREATE TABLE entry_events (
    id uuid PRIMARY KEY,
    giveaway_id uuid NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    event_type text NOT NULL CHECK (event_type IN ('join', 'leave', 'rejoin', 'rejected')),
    username text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entry_events_giveaway_time_idx ON entry_events(giveaway_id, occurred_at);

CREATE TABLE draws (
    id uuid PRIMARY KEY,
    giveaway_id uuid NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
    draw_number integer NOT NULL,
    requested_by_user_id text,
    requested_at timestamptz NOT NULL DEFAULT now(),
    candidate_hash text,
    drand_chain_hash text NOT NULL,
    drand_round bigint NOT NULL,
    drand_beacon_time timestamptz NOT NULL,
    drand_signature text,
    drand_randomness text,
    drand_beacon jsonb,
    status text NOT NULL CHECK (status IN ('awaiting_beacon', 'drawing', 'complete', 'failed')),
    completed_at timestamptz,
    error text,
    UNIQUE (giveaway_id, draw_number)
);

CREATE TABLE draw_candidates (
    draw_id uuid NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    username text NOT NULL,
    joined_at timestamptz NOT NULL,
    weight integer NOT NULL CHECK (weight > 0),
    ordinal integer NOT NULL,
    PRIMARY KEY (draw_id, user_id),
    UNIQUE (draw_id, ordinal)
);

CREATE TABLE draw_exclusions (
    draw_id uuid NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    reason text NOT NULL,
    PRIMARY KEY (draw_id, user_id)
);

CREATE TABLE draw_winners (
    draw_id uuid NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    username text NOT NULL,
    position integer NOT NULL CHECK (position > 0),
    PRIMARY KEY (draw_id, user_id),
    UNIQUE (draw_id, position)
);

CREATE TABLE role_ownership (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    role_id text NOT NULL,
    owned_before_bot boolean NOT NULL,
    first_observed_at timestamptz NOT NULL DEFAULT now(),
    last_observed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, user_id, role_id)
);

CREATE TABLE role_grant_claims (
    giveaway_id uuid NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
    draw_id uuid NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
    guild_id text NOT NULL,
    user_id text NOT NULL,
    role_id text NOT NULL,
    bot_added boolean NOT NULL DEFAULT false,
    active boolean NOT NULL DEFAULT true,
    granted_at timestamptz,
    removed_at timestamptz,
    error text,
    PRIMARY KEY (draw_id, user_id, role_id)
);
CREATE INDEX role_grant_active_idx ON role_grant_claims(guild_id, user_id, role_id) WHERE active;

CREATE TABLE audit_events (
    id uuid PRIMARY KEY,
    guild_id text NOT NULL,
    giveaway_id uuid REFERENCES giveaways(id) ON DELETE SET NULL,
    actor_user_id text,
    action text NOT NULL,
    source text NOT NULL CHECK (source IN ('discord', 'web', 'worker', 'system')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_giveaway_idx ON audit_events(giveaway_id, occurred_at);
CREATE INDEX audit_events_guild_idx ON audit_events(guild_id, occurred_at DESC);

CREATE TABLE jobs (
    id uuid PRIMARY KEY,
    type text NOT NULL,
    giveaway_id uuid REFERENCES giveaways(id) ON DELETE CASCADE,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    run_at timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 10,
    locked_at timestamptz,
    locked_by text,
    last_error text,
    completed_at timestamptz,
    idempotency_key text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs(run_at, created_at)
    WHERE completed_at IS NULL AND locked_at IS NULL;
CREATE UNIQUE INDEX jobs_idempotency_idx ON jobs(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE oauth_accounts (
    user_id text PRIMARY KEY,
    username text NOT NULL,
    global_name text,
    avatar_hash text,
    access_token_ciphertext text NOT NULL,
    refresh_token_ciphertext text,
    expires_at timestamptz NOT NULL,
    scope text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE web_sessions (
    id_hash text PRIMARY KEY,
    user_id text NOT NULL REFERENCES oauth_accounts(user_id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE data_deletion_requests (
    id uuid PRIMARY KEY,
    user_id text NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    status text NOT NULL CHECK (status IN ('queued', 'processing', 'complete', 'failed')),
    error text
);
