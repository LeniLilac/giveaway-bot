\set ON_ERROR_STOP on
\getenv bot_user BOT_DATABASE_USER
\getenv worker_user WORKER_DATABASE_USER
\getenv web_user WEB_DATABASE_USER

CREATE OR REPLACE FUNCTION role_policy_default_probe() RETURNS integer
LANGUAGE sql AS 'SELECT 1';

SELECT (
  has_table_privilege(:'bot_user', 'giveaways', 'SELECT')
  AND has_column_privilege(:'bot_user', 'giveaways', 'participant_count', 'UPDATE')
  AND NOT has_column_privilege(:'bot_user', 'giveaways', 'status', 'UPDATE')
  AND NOT has_table_privilege(:'bot_user', 'draws', 'UPDATE')
  AND has_table_privilege(:'worker_user', 'draws', 'SELECT,INSERT,UPDATE')
  AND NOT has_table_privilege(:'worker_user', 'draws', 'DELETE')
  AND NOT has_table_privilege(:'worker_user', 'schema_migrations', 'SELECT')
  AND has_column_privilege(:'web_user', 'giveaways', 'updated_at', 'UPDATE')
  AND NOT has_column_privilege(:'web_user', 'giveaways', 'status', 'UPDATE')
  AND NOT has_column_privilege(
    :'web_user', 'data_deletion_requests', 'error', 'UPDATE'
  )
  AND has_table_privilege(:'web_user', 'guild_command_roles', 'DELETE')
  AND NOT has_database_privilege(:'web_user', 'postgres', 'CONNECT')
  AND NOT has_database_privilege(:'web_user', current_database(), 'CREATE,TEMP')
  AND NOT has_schema_privilege(:'web_user', 'public', 'CREATE')
  AND NOT has_function_privilege(
    :'bot_user', 'role_policy_default_probe()', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    :'worker_user', 'protect_draw_evidence()', 'EXECUTE'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN (:'bot_user', :'worker_user', :'web_user')
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE granted_role.rolname IN (:'bot_user', :'worker_user', :'web_user')
       OR member_role.rolname IN (:'bot_user', :'worker_user', :'web_user')
  )
) AS runtime_role_policy_ok \gset

\if :runtime_role_policy_ok
\else
  DO $fail$ BEGIN
    RAISE EXCEPTION 'Runtime database role policy assertions failed.';
  END $fail$;
\endif

DROP FUNCTION role_policy_default_probe();
