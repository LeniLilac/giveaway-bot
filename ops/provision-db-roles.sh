#!/bin/sh
set -eu

: "${BOT_DATABASE_USER:?BOT_DATABASE_USER is required}"
: "${BOT_DATABASE_PASSWORD:?BOT_DATABASE_PASSWORD is required}"
: "${WORKER_DATABASE_USER:?WORKER_DATABASE_USER is required}"
: "${WORKER_DATABASE_PASSWORD:?WORKER_DATABASE_PASSWORD is required}"
: "${WEB_DATABASE_USER:?WEB_DATABASE_USER is required}"
: "${WEB_DATABASE_PASSWORD:?WEB_DATABASE_PASSWORD is required}"

validate_role_name() {
  role_name="$1"
  if ! printf '%s' "$role_name" | grep -Eq '^[a-z_][a-z0-9_]{0,62}$'; then
    echo "Database role names must be lowercase PostgreSQL identifiers." >&2
    exit 1
  fi
  case "$role_name" in
    postgres|public|"${PGUSER:-}")
      echo "Runtime database roles must differ from the migration administrator." >&2
      exit 1
      ;;
  esac
}

validate_password() {
  password_length="$(LC_ALL=C printf '%s' "$1" | wc -c | tr -d ' ')"
  if [ "$password_length" -lt 32 ]; then
    echo "Runtime database passwords must contain at least 32 bytes." >&2
    exit 1
  fi
}

validate_role_name "$BOT_DATABASE_USER"
validate_role_name "$WORKER_DATABASE_USER"
validate_role_name "$WEB_DATABASE_USER"
validate_password "$BOT_DATABASE_PASSWORD"
validate_password "$WORKER_DATABASE_PASSWORD"
validate_password "$WEB_DATABASE_PASSWORD"

if [ "$BOT_DATABASE_USER" = "$WORKER_DATABASE_USER" ] ||
   [ "$BOT_DATABASE_USER" = "$WEB_DATABASE_USER" ] ||
   [ "$WORKER_DATABASE_USER" = "$WEB_DATABASE_USER" ]; then
  echo "Bot, worker, and web database roles must be distinct." >&2
  exit 1
fi

roles_sql="${DATABASE_ROLES_SQL_PATH:-/opt/lilac/database-runtime-roles.sql}"
if [ ! -r "$roles_sql" ]; then
  echo "Database role policy is missing: $roles_sql" >&2
  exit 1
fi

# The SQL policy imports values with psql's \getenv. In particular, passwords
# must never be copied into process arguments where host process listings could
# expose them.
exec psql --no-psqlrc --set=ON_ERROR_STOP=1 --file="$roles_sql"
