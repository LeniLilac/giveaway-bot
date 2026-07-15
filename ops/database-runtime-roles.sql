\set ON_ERROR_STOP on
\getenv bot_user BOT_DATABASE_USER
\getenv bot_password BOT_DATABASE_PASSWORD
\getenv worker_user WORKER_DATABASE_USER
\getenv worker_password WORKER_DATABASE_PASSWORD
\getenv web_user WEB_DATABASE_USER
\getenv web_password WEB_DATABASE_PASSWORD

BEGIN;

-- Runtime identities are deliberately separate from the migration owner. This
-- script is rerun after every forward migration so new tables are not exposed
-- until their grants are reviewed here.
SELECT format('CREATE ROLE %I', :'bot_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'bot_user') \gexec
SELECT format('CREATE ROLE %I', :'worker_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'worker_user') \gexec
SELECT format('CREATE ROLE %I', :'web_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'web_user') \gexec

-- A pre-existing configured role could retain owner powers or SET ROLE access
-- even after ordinary ACL revocation. Refuse to repurpose it in that state;
-- operators must transfer ownership/remove membership after auditing it.
SELECT EXISTS (
  SELECT 1
  FROM pg_auth_members membership
  JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
  JOIN pg_roles member_role ON member_role.oid = membership.member
  WHERE granted_role.rolname IN (:'bot_user', :'worker_user', :'web_user')
     OR member_role.rolname IN (:'bot_user', :'worker_user', :'web_user')
) AS unsafe_runtime_membership \gset
\if :unsafe_runtime_membership
  DO $fail$ BEGIN
    RAISE EXCEPTION 'Runtime database roles must not participate in role memberships.';
  END $fail$;
\endif

SELECT EXISTS (
  SELECT 1
  FROM pg_shdepend dependency
  JOIN pg_roles owner_role ON owner_role.oid = dependency.refobjid
  WHERE dependency.refclassid = 'pg_authid'::regclass
    AND dependency.deptype = 'o'
    AND owner_role.rolname IN (:'bot_user', :'worker_user', :'web_user')
) AS unsafe_runtime_ownership \gset
\if :unsafe_runtime_ownership
  DO $fail$ BEGIN
    RAISE EXCEPTION 'Runtime database roles must not own database objects.';
  END $fail$;
\endif

SELECT format(
  'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20 PASSWORD %L',
  :'bot_user', :'bot_password'
) \gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20 PASSWORD %L',
  :'worker_user', :'worker_password'
) \gexec
SELECT format(
  'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20 PASSWORD %L',
  :'web_user', :'web_password'
) \gexec

SELECT format('ALTER ROLE %I RESET ALL', :'bot_user') \gexec
SELECT format('ALTER ROLE %I RESET ALL', :'worker_user') \gexec
SELECT format('ALTER ROLE %I RESET ALL', :'web_user') \gexec
SELECT format(
  'ALTER ROLE %I IN DATABASE %I RESET ALL', :'bot_user', current_database()
) \gexec
SELECT format(
  'ALTER ROLE %I IN DATABASE %I RESET ALL', :'worker_user', current_database()
) \gexec
SELECT format(
  'ALTER ROLE %I IN DATABASE %I RESET ALL', :'web_user', current_database()
) \gexec

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- This is a dedicated application cluster. Prevent runtime credentials from
-- falling back to another database through PostgreSQL's default PUBLIC ACLs.
SELECT format(
  'REVOKE CONNECT, CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC', datname
) FROM pg_database WHERE datallowconn AND NOT datistemplate \gexec
SELECT format(
  'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', datname, :'bot_user'
) FROM pg_database WHERE datallowconn AND NOT datistemplate \gexec
SELECT format(
  'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', datname, :'worker_user'
) FROM pg_database WHERE datallowconn AND NOT datistemplate \gexec
SELECT format(
  'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', datname, :'web_user'
) FROM pg_database WHERE datallowconn AND NOT datistemplate \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'bot_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'worker_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'web_user') \gexec

SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', :'bot_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', :'worker_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', :'web_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'bot_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'worker_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'web_user') \gexec

SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', :'bot_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', :'worker_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', :'web_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', :'bot_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', :'worker_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', :'web_user') \gexec
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
SELECT format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I', :'bot_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I', :'worker_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I', :'web_user') \gexec

-- PostgreSQL otherwise grants PUBLIC execute on newly created functions. Keep
-- every future object private until this explicit policy is reviewed/reapplied.
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TYPES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TYPES FROM PUBLIC;
SELECT format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM %I', :'bot_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM %I', :'worker_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM %I', :'web_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM %I', :'bot_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM %I', :'worker_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM %I', :'web_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM %I', :'bot_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM %I', :'worker_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM %I', :'web_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON TYPES FROM %I', :'bot_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON TYPES FROM %I', :'worker_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON TYPES FROM %I', :'web_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', :'bot_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', :'worker_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', :'web_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', :'bot_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', :'worker_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', :'web_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', :'bot_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', :'worker_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', :'web_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TYPES FROM %I', :'bot_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TYPES FROM %I', :'worker_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TYPES FROM %I', :'web_user') \gexec

SELECT format($grant$
  GRANT SELECT ON TABLE
    guild_command_roles, giveaway_drafts, giveaways,
    giveaway_required_roles, giveaway_prize_roles, giveaway_bonus_roles,
    entries, draws, jobs, data_deletion_requests, privacy_deletion_fences
  TO %I
$grant$, :'bot_user') \gexec
SELECT format($grant$
  GRANT INSERT ON TABLE
    guild_settings, giveaway_drafts, giveaways, giveaway_required_roles,
    giveaway_prize_roles, giveaway_bonus_roles, entries, entry_events,
    audit_events, jobs
  TO %I
$grant$, :'bot_user') \gexec
SELECT format('GRANT UPDATE (guild_name, guild_icon, updated_at) ON TABLE guild_settings TO %I', :'bot_user') \gexec
SELECT format('GRANT UPDATE (payload, state, consumed_at) ON TABLE giveaway_drafts TO %I', :'bot_user') \gexec
SELECT format('GRANT UPDATE (participant_count, updated_at) ON TABLE giveaways TO %I', :'bot_user') \gexec
SELECT format(
  'GRANT UPDATE (username, global_name, avatar_hash, joined_at, left_at, eligible_at_draw, draw_weight, ineligible_reason) ON TABLE entries TO %I',
  :'bot_user'
) \gexec
SELECT format('GRANT UPDATE (run_at, payload, attempts, last_error) ON TABLE jobs TO %I', :'bot_user') \gexec
SELECT format('GRANT UPDATE (cleared_at, updated_at) ON TABLE privacy_deletion_fences TO %I', :'bot_user') \gexec

SELECT format($grant$
  GRANT SELECT ON TABLE
    privacy_consents, giveaway_drafts,
    giveaways, giveaway_required_roles, giveaway_prize_roles,
    giveaway_bonus_roles, entries, entry_events, draws, draw_candidates,
    draw_exclusions, draw_winners, role_ownership, role_grant_claims,
    audit_events, jobs, oauth_accounts, web_sessions, data_deletion_requests,
    privacy_deletion_fences, discord_deliveries
  TO %I
$grant$, :'worker_user') \gexec
SELECT format($grant$
  GRANT INSERT ON TABLE
    draws, draw_candidates, draw_exclusions, draw_winners, role_ownership,
    role_grant_claims, audit_events, jobs, privacy_deletion_fences,
    discord_deliveries
  TO %I
$grant$, :'worker_user') \gexec
SELECT format($grant$
  GRANT UPDATE ON TABLE
    giveaway_drafts, giveaways, entries, entry_events, draws,
    draw_candidates, draw_exclusions, draw_winners, role_ownership,
    role_grant_claims, audit_events, jobs, data_deletion_requests,
    privacy_deletion_fences, discord_deliveries
  TO %I
$grant$, :'worker_user') \gexec
SELECT format($grant$
  GRANT DELETE ON TABLE
    privacy_consents, giveaway_drafts, oauth_accounts, web_sessions
  TO %I
$grant$, :'worker_user') \gexec

SELECT format($grant$
  GRANT SELECT ON TABLE
    guild_command_roles, giveaways, giveaway_required_roles,
    giveaway_prize_roles, giveaway_bonus_roles, entries, entry_events, draws,
    draw_candidates, draw_exclusions, draw_winners, audit_events, jobs,
    oauth_accounts, web_sessions, data_deletion_requests,
    privacy_deletion_fences
  TO %I
$grant$, :'web_user') \gexec
SELECT format($grant$
  GRANT INSERT ON TABLE
    guild_settings, guild_command_roles, oauth_accounts, web_sessions,
    data_deletion_requests, privacy_deletion_fences, jobs, audit_events
  TO %I
$grant$, :'web_user') \gexec
SELECT format('GRANT UPDATE (guild_name, guild_icon, updated_at) ON TABLE guild_settings TO %I', :'web_user') \gexec
SELECT format(
  'GRANT UPDATE (username, global_name, avatar_hash, access_token_ciphertext, refresh_token_ciphertext, expires_at, scope, updated_at) ON TABLE oauth_accounts TO %I',
  :'web_user'
) \gexec
SELECT format('GRANT UPDATE (last_seen_at) ON TABLE web_sessions TO %I', :'web_user') \gexec
SELECT format(
  'GRANT UPDATE (request_id, requested_at, completed_at, cleared_at, updated_at) ON TABLE privacy_deletion_fences TO %I',
  :'web_user'
) \gexec
SELECT format(
  'GRANT UPDATE (run_at, payload, attempts, last_error, completed_at, locked_at, locked_by, lock_token, lease_expires_at) ON TABLE jobs TO %I',
  :'web_user'
) \gexec
-- SELECT ... FOR UPDATE on giveaways serializes web actions/privacy requests
-- with lifecycle and snapshot work without granting other schema privileges.
SELECT format('GRANT UPDATE (updated_at) ON TABLE giveaways TO %I', :'web_user') \gexec
SELECT format('GRANT DELETE ON TABLE guild_command_roles, web_sessions TO %I', :'web_user') \gexec

SELECT format(
  'ALTER ROLE %I IN DATABASE %I SET search_path = pg_catalog, public',
  :'bot_user', current_database()
) \gexec
SELECT format(
  'ALTER ROLE %I IN DATABASE %I SET search_path = pg_catalog, public',
  :'worker_user', current_database()
) \gexec
SELECT format(
  'ALTER ROLE %I IN DATABASE %I SET search_path = pg_catalog, public',
  :'web_user', current_database()
) \gexec
SELECT format(
  'ALTER ROLE %I IN DATABASE %I SET statement_timeout = %L',
  :'bot_user', current_database(), '15s'
) \gexec
SELECT format(
  'ALTER ROLE %I IN DATABASE %I SET statement_timeout = %L',
  :'worker_user', current_database(), '120s'
) \gexec
SELECT format(
  'ALTER ROLE %I IN DATABASE %I SET statement_timeout = %L',
  :'web_user', current_database(), '15s'
) \gexec
SELECT format(
  'ALTER ROLE %I IN DATABASE %I SET idle_in_transaction_session_timeout = %L',
  :'bot_user', current_database(), '30s'
) \gexec
SELECT format(
  'ALTER ROLE %I IN DATABASE %I SET idle_in_transaction_session_timeout = %L',
  :'worker_user', current_database(), '5min'
) \gexec
SELECT format(
  'ALTER ROLE %I IN DATABASE %I SET idle_in_transaction_session_timeout = %L',
  :'web_user', current_database(), '30s'
) \gexec

COMMIT;
