-- Forward-only hardening for proof identity, job leases, Discord delivery, and
-- prize-role provenance. Existing draws retain the v1 proof contract.

ALTER TABLE draws
    ADD COLUMN proof_version text,
    ADD COLUMN proof_redacted_at timestamptz,
    ADD COLUMN commitment_published_at timestamptz,
    ADD COLUMN roles_reconciled_at timestamptz,
    ADD COLUMN message_refreshed_at timestamptz,
    ADD COLUMN winners_announced_at timestamptz,
    ADD COLUMN delivery_completed_at timestamptz;

UPDATE draws SET proof_version = 'lilac-weighted-v1';
UPDATE draws
SET commitment_published_at = requested_at,
    roles_reconciled_at = CASE WHEN status = 'complete' THEN completed_at END,
    message_refreshed_at = CASE WHEN status = 'complete' THEN completed_at END,
    winners_announced_at = CASE WHEN status = 'complete' THEN completed_at END,
    delivery_completed_at = CASE WHEN status = 'complete' THEN completed_at END;

UPDATE draws draw
SET proof_redacted_at = now()
WHERE EXISTS (
    SELECT 1 FROM draw_candidates candidate
    WHERE candidate.draw_id = draw.id AND candidate.user_id LIKE 'deleted:%'
);

ALTER TABLE draws
    ALTER COLUMN proof_version SET NOT NULL,
    ALTER COLUMN proof_version SET DEFAULT 'lilac-weighted-v2',
    ADD CONSTRAINT draws_proof_version_check
        CHECK (proof_version IN ('lilac-weighted-v1', 'lilac-weighted-v2')),
    ALTER COLUMN requested_winner_count TYPE bigint;

ALTER TABLE draw_candidates
    ADD COLUMN proof_id text,
    ALTER COLUMN weight TYPE bigint,
    ADD CONSTRAINT draw_candidates_proof_id_format
        CHECK (proof_id IS NULL OR proof_id ~ '^[a-f0-9]{64}$');

ALTER TABLE draw_winners
    ADD COLUMN proof_id text,
    ADD CONSTRAINT draw_winners_proof_id_format
        CHECK (proof_id IS NULL OR proof_id ~ '^[a-f0-9]{64}$');
ALTER TABLE draw_exclusions
    ADD COLUMN proof_id text,
    ADD CONSTRAINT draw_exclusions_proof_id_format
        CHECK (proof_id IS NULL OR proof_id ~ '^[a-f0-9]{64}$');
ALTER TABLE entries ALTER COLUMN draw_weight TYPE bigint;

CREATE INDEX entries_snapshot_order_idx
    ON entries(giveaway_id, joined_at, user_id) WHERE left_at IS NULL;
CREATE INDEX entries_public_order_idx
    ON entries(giveaway_id, joined_at, user_id);

CREATE TABLE privacy_deletion_fences (
    user_id_hash text PRIMARY KEY CHECK (user_id_hash ~ '^[a-f0-9]{64}$'),
    request_id uuid REFERENCES data_deletion_requests(id) ON DELETE SET NULL,
    requested_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    cleared_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX privacy_deletion_fences_active_idx
    ON privacy_deletion_fences(user_id_hash) WHERE cleared_at IS NULL;

CREATE UNIQUE INDEX draw_candidates_proof_id_idx
    ON draw_candidates(draw_id, proof_id) WHERE proof_id IS NOT NULL;
CREATE UNIQUE INDEX draw_winners_proof_id_idx
    ON draw_winners(draw_id, proof_id) WHERE proof_id IS NOT NULL;
CREATE INDEX draw_exclusions_proof_id_idx
    ON draw_exclusions(draw_id, proof_id) WHERE proof_id IS NOT NULL;

-- Canonical proof fields are immutable. Privacy deletion may redact the
-- display-only user_id and username columns without changing the commitment.
CREATE FUNCTION protect_draw_candidate_proof_fields() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    draw_proof_version text;
    draw_proof_redacted_at timestamptz;
BEGIN
    SELECT proof_version, proof_redacted_at
    INTO draw_proof_version, draw_proof_redacted_at
    FROM draws WHERE id = OLD.draw_id;
    IF (NEW.proof_id IS DISTINCT FROM OLD.proof_id AND NOT (
          draw_proof_version = 'lilac-weighted-v1'
          AND OLD.proof_id IS NULL
          AND NEW.proof_id IS NOT NULL
          AND draw_proof_redacted_at IS NOT NULL
       ))
       OR NEW.joined_at IS DISTINCT FROM OLD.joined_at
       OR NEW.weight IS DISTINCT FROM OLD.weight
       OR NEW.ordinal IS DISTINCT FROM OLD.ordinal THEN
        RAISE EXCEPTION 'canonical draw candidate proof fields are immutable';
    END IF;
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        IF draw_proof_version = 'lilac-weighted-v1'
           AND (draw_proof_redacted_at IS NULL OR NEW.user_id NOT LIKE 'deleted:%') THEN
            RAISE EXCEPTION 'v1 candidate user_id is canonical and may only be privacy-redacted';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER draw_candidate_proof_fields_immutable
BEFORE UPDATE ON draw_candidates
FOR EACH ROW EXECUTE FUNCTION protect_draw_candidate_proof_fields();

CREATE FUNCTION enforce_v2_proof_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    draw_proof_version text;
BEGIN
    SELECT proof_version INTO draw_proof_version FROM draws WHERE id = NEW.draw_id;
    IF draw_proof_version = 'lilac-weighted-v2' AND NEW.proof_id IS NULL THEN
        RAISE EXCEPTION 'v2 draw records require proof_id';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.proof_id IS DISTINCT FROM OLD.proof_id AND NOT (
         draw_proof_version = 'lilac-weighted-v1'
         AND OLD.proof_id IS NULL
         AND NEW.proof_id IS NOT NULL
       ) THEN
        RAISE EXCEPTION 'draw proof_id is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER draw_candidate_v2_identity
BEFORE INSERT ON draw_candidates
FOR EACH ROW EXECUTE FUNCTION enforce_v2_proof_identity();
CREATE TRIGGER draw_winner_v2_identity
BEFORE INSERT OR UPDATE ON draw_winners
FOR EACH ROW EXECUTE FUNCTION enforce_v2_proof_identity();
CREATE TRIGGER draw_exclusion_v2_identity
BEFORE INSERT OR UPDATE ON draw_exclusions
FOR EACH ROW EXECUTE FUNCTION enforce_v2_proof_identity();

-- Once a commitment is public, its canonical draw inputs cannot be rewritten.
-- Completion fills the beacon output exactly once; privacy redaction and the
-- crash-recovery delivery timestamps remain deliberately mutable.
CREATE FUNCTION validate_new_draw_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.proof_version <> 'lilac-weighted-v2' THEN
        RAISE EXCEPTION 'new draws must use lilac-weighted-v2';
    END IF;
    IF NEW.status <> 'awaiting_beacon'
       OR NEW.commitment_published_at IS NOT NULL
       OR NEW.drand_signature IS NOT NULL
       OR NEW.drand_randomness IS NOT NULL
       OR NEW.drand_beacon IS NOT NULL
       OR NEW.completed_at IS NOT NULL THEN
        RAISE EXCEPTION 'draws must be inserted as unpublished awaiting commitments';
    END IF;
    IF NEW.candidate_hash IS NULL OR NEW.candidate_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'new draws require a canonical candidate hash';
    END IF;
    IF NEW.drand_beacon_time < clock_timestamp() + interval '15 seconds' THEN
        RAISE EXCEPTION 'new draws require a beacon at least 15 seconds in the future';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER draw_evidence_valid_on_insert
BEFORE INSERT ON draws
FOR EACH ROW EXECUTE FUNCTION validate_new_draw_evidence();

CREATE FUNCTION protect_draw_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.commitment_published_at IS NOT NULL THEN
            RAISE EXCEPTION 'published draws cannot be deleted';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.requested_by_user_id IS DISTINCT FROM NEW.requested_by_user_id
       AND NEW.requested_by_user_id IS NOT NULL THEN
        RAISE EXCEPTION 'draw requester identity may only be privacy-redacted';
    END IF;

    IF NEW.proof_version IS DISTINCT FROM OLD.proof_version THEN
        RAISE EXCEPTION 'draw proof version is immutable';
    END IF;

    IF OLD.proof_redacted_at IS NOT NULL
       AND NEW.proof_redacted_at IS DISTINCT FROM OLD.proof_redacted_at THEN
        RAISE EXCEPTION 'draw proof redaction is irreversible';
    END IF;

    IF OLD.commitment_published_at IS NOT NULL
       OR (OLD.commitment_published_at IS NULL AND NEW.commitment_published_at IS NOT NULL) THEN
        IF NEW.giveaway_id IS DISTINCT FROM OLD.giveaway_id
           OR NEW.draw_number IS DISTINCT FROM OLD.draw_number
           OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
           OR NEW.requested_winner_count IS DISTINCT FROM OLD.requested_winner_count
           OR NEW.candidate_hash IS DISTINCT FROM OLD.candidate_hash
           OR NEW.drand_chain_hash IS DISTINCT FROM OLD.drand_chain_hash
           OR NEW.drand_round IS DISTINCT FROM OLD.drand_round
           OR NEW.drand_beacon_time IS DISTINCT FROM OLD.drand_beacon_time
           OR NEW.proof_version IS DISTINCT FROM OLD.proof_version THEN
            RAISE EXCEPTION 'published draw commitment fields are immutable';
        END IF;
    END IF;

    IF OLD.commitment_published_at IS NOT NULL
       AND NEW.commitment_published_at IS DISTINCT FROM OLD.commitment_published_at THEN
        RAISE EXCEPTION 'draw publication timestamp is immutable';
    END IF;

    IF OLD.commitment_published_at IS NULL
       AND NEW.commitment_published_at IS NOT NULL
       AND (NEW.candidate_hash IS NULL
            OR NEW.candidate_hash !~ '^[a-f0-9]{64}$'
            OR NEW.drand_beacon_time < clock_timestamp() + interval '15 seconds') THEN
        RAISE EXCEPTION 'a draw cannot be published without a hash and future beacon';
    END IF;

    IF NEW.status = 'complete' AND OLD.status <> 'complete' THEN
        IF NEW.commitment_published_at IS NULL
           OR NEW.drand_signature IS NULL
           OR NEW.drand_randomness IS NULL
           OR NEW.drand_beacon IS NULL
           OR NEW.completed_at IS NULL
           OR NEW.drand_beacon_time > clock_timestamp() THEN
            RAISE EXCEPTION 'draw completion requires published beacon evidence';
        END IF;
    END IF;

    IF NEW.status <> 'complete'
       AND (NEW.drand_signature IS NOT NULL
            OR NEW.drand_randomness IS NOT NULL
            OR NEW.drand_beacon IS NOT NULL
            OR NEW.completed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'beacon output may only be persisted with draw completion';
    END IF;

    IF OLD.status = 'complete' THEN
        IF NEW.status IS DISTINCT FROM OLD.status
           OR NEW.drand_signature IS DISTINCT FROM OLD.drand_signature
           OR NEW.drand_randomness IS DISTINCT FROM OLD.drand_randomness
           OR NEW.drand_beacon IS DISTINCT FROM OLD.drand_beacon
           OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
            RAISE EXCEPTION 'completed draw evidence is immutable';
        END IF;
    END IF;

    IF (OLD.roles_reconciled_at IS NOT NULL
          AND NEW.roles_reconciled_at IS DISTINCT FROM OLD.roles_reconciled_at)
       OR (OLD.message_refreshed_at IS NOT NULL
          AND NEW.message_refreshed_at IS DISTINCT FROM OLD.message_refreshed_at)
       OR (OLD.winners_announced_at IS NOT NULL
          AND NEW.winners_announced_at IS DISTINCT FROM OLD.winners_announced_at)
       OR (OLD.delivery_completed_at IS NOT NULL
          AND NEW.delivery_completed_at IS DISTINCT FROM OLD.delivery_completed_at) THEN
        RAISE EXCEPTION 'draw delivery completion timestamps are irreversible';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER draw_evidence_immutable
BEFORE UPDATE OR DELETE ON draws
FOR EACH ROW EXECUTE FUNCTION protect_draw_evidence();

-- Child triggers lock their parent draw so a child mutation cannot observe an
-- unpublished state and then commit after a concurrent publication update.
CREATE FUNCTION protect_draw_candidate_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    draw_record draws%ROWTYPE;
    target_draw_id uuid;
BEGIN
    target_draw_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.draw_id ELSE NEW.draw_id END;
    SELECT * INTO draw_record FROM draws WHERE id = target_draw_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'candidate parent draw does not exist';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF draw_record.commitment_published_at IS NOT NULL THEN
            RAISE EXCEPTION 'candidates cannot be inserted after publication';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF draw_record.commitment_published_at IS NOT NULL THEN
            RAISE EXCEPTION 'candidates cannot be deleted after publication';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW.draw_id IS DISTINCT FROM OLD.draw_id THEN
        RAISE EXCEPTION 'candidate draw identity is immutable';
    END IF;
    IF NEW.username IS DISTINCT FROM OLD.username
       OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        IF OLD.user_id LIKE 'deleted:%'
           OR NEW.user_id NOT LIKE 'deleted:%'
           OR NEW.username <> 'Deleted User'
           OR (draw_record.proof_version = 'lilac-weighted-v1'
               AND draw_record.proof_redacted_at IS NULL) THEN
            RAISE EXCEPTION 'candidate display identity may only be privacy-redacted';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER draw_candidate_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON draw_candidates
FOR EACH ROW EXECUTE FUNCTION protect_draw_candidate_mutation();

CREATE FUNCTION protect_draw_exclusion_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    draw_record draws%ROWTYPE;
    target_draw_id uuid;
BEGIN
    target_draw_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.draw_id ELSE NEW.draw_id END;
    SELECT * INTO draw_record FROM draws WHERE id = target_draw_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'exclusion parent draw does not exist';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF draw_record.commitment_published_at IS NOT NULL THEN
            RAISE EXCEPTION 'exclusions cannot be inserted after publication';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF draw_record.commitment_published_at IS NOT NULL THEN
            RAISE EXCEPTION 'exclusions cannot be deleted after publication';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW.draw_id IS DISTINCT FROM OLD.draw_id
       OR NEW.reason IS DISTINCT FROM OLD.reason THEN
        RAISE EXCEPTION 'exclusion evidence is immutable';
    END IF;
    IF NEW.proof_id IS DISTINCT FROM OLD.proof_id AND NOT (
         draw_record.proof_version = 'lilac-weighted-v1'
         AND OLD.proof_id IS NULL
         AND NEW.proof_id IS NOT NULL
         AND draw_record.proof_redacted_at IS NOT NULL
       ) THEN
        RAISE EXCEPTION 'exclusion proof identity is immutable';
    END IF;
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        IF OLD.user_id LIKE 'deleted:%'
           OR NEW.user_id NOT LIKE 'deleted:%'
           OR (draw_record.proof_version = 'lilac-weighted-v1'
               AND draw_record.proof_redacted_at IS NULL) THEN
            RAISE EXCEPTION 'exclusion display identity may only be privacy-redacted';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER draw_exclusion_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON draw_exclusions
FOR EACH ROW EXECUTE FUNCTION protect_draw_exclusion_mutation();

CREATE FUNCTION protect_draw_winner_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    draw_record draws%ROWTYPE;
    target_draw_id uuid;
BEGIN
    target_draw_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.draw_id ELSE NEW.draw_id END;
    SELECT * INTO draw_record FROM draws WHERE id = target_draw_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'winner parent draw does not exist';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF draw_record.commitment_published_at IS NULL
           OR draw_record.status NOT IN ('awaiting_beacon', 'drawing') THEN
            RAISE EXCEPTION 'winners may only be inserted while completing a published draw';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM draw_candidates candidate
          WHERE candidate.draw_id = NEW.draw_id
            AND (
              (NEW.proof_id IS NOT NULL AND candidate.proof_id = NEW.proof_id)
              OR (NEW.proof_id IS NULL AND candidate.user_id = NEW.user_id)
            )
        ) THEN
            RAISE EXCEPTION 'winner must reference a committed candidate';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'selected winners cannot be deleted';
    END IF;

    IF NEW.draw_id IS DISTINCT FROM OLD.draw_id
       OR NEW.position IS DISTINCT FROM OLD.position THEN
        RAISE EXCEPTION 'winner selection evidence is immutable';
    END IF;
    IF NEW.proof_id IS DISTINCT FROM OLD.proof_id AND NOT (
         draw_record.proof_version = 'lilac-weighted-v1'
         AND OLD.proof_id IS NULL
         AND NEW.proof_id IS NOT NULL
         AND draw_record.proof_redacted_at IS NOT NULL
       ) THEN
        RAISE EXCEPTION 'winner proof identity is immutable';
    END IF;
    IF NEW.username IS DISTINCT FROM OLD.username
       OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        IF OLD.user_id LIKE 'deleted:%'
           OR NEW.user_id NOT LIKE 'deleted:%'
           OR NEW.username <> 'Deleted User'
           OR (draw_record.proof_version = 'lilac-weighted-v1'
               AND draw_record.proof_redacted_at IS NULL) THEN
            RAISE EXCEPTION 'winner display identity may only be privacy-redacted';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER draw_winner_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON draw_winners
FOR EACH ROW EXECUTE FUNCTION protect_draw_winner_mutation();

UPDATE jobs
SET completed_at = COALESCE(completed_at, now()),
    locked_at = NULL,
    locked_by = NULL,
    last_error = 'Quarantined by migration 003: unsupported legacy job type.'
WHERE type NOT IN (
    'start_giveaway', 'refresh_giveaway', 'end_giveaway',
    'reroll_giveaway', 'complete_draw', 'delete_giveaway', 'privacy_delete'
);

ALTER TABLE jobs
    ADD COLUMN lock_token uuid,
    ADD COLUMN lease_expires_at timestamptz,
    ADD CONSTRAINT jobs_type_check CHECK (type IN (
        'start_giveaway',
        'refresh_giveaway',
        'end_giveaway',
        'reroll_giveaway',
        'complete_draw',
        'delete_giveaway',
        'privacy_delete'
    ));

DROP INDEX jobs_ready_idx;
CREATE INDEX jobs_ready_idx ON jobs(run_at, created_at)
    WHERE completed_at IS NULL;

CREATE TABLE discord_deliveries (
    delivery_key text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN (
        'giveaway_start', 'winner_message', 'reroll_rejection'
    )),
    giveaway_id uuid NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
    draw_id uuid REFERENCES draws(id) ON DELETE CASCADE,
    ordinal integer CHECK (ordinal >= 0),
    nonce text NOT NULL UNIQUE,
    claim_token uuid,
    claim_expires_at timestamptz,
    send_started_at timestamptz,
    external_id text,
    delivered_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (draw_id, kind, ordinal),
    CHECK (
        (kind = 'winner_message' AND draw_id IS NOT NULL AND ordinal IS NOT NULL)
        OR (kind <> 'winner_message' AND draw_id IS NULL AND ordinal IS NULL)
    ),
    CHECK ((external_id IS NULL) = (delivered_at IS NULL))
);
CREATE INDEX discord_deliveries_claim_idx
    ON discord_deliveries(claim_expires_at)
    WHERE delivered_at IS NULL;

ALTER TABLE role_ownership
    ADD COLUMN bot_added boolean NOT NULL DEFAULT false,
    ADD COLUMN operation text NOT NULL DEFAULT 'idle',
    ADD COLUMN operation_error text,
    ADD CONSTRAINT role_ownership_operation_check
        CHECK (operation IN ('idle', 'add_pending', 'remove_pending'));

UPDATE role_ownership ownership
SET bot_added = true,
    owned_before_bot = false
WHERE EXISTS (
      SELECT 1 FROM role_grant_claims claim
      WHERE claim.guild_id = ownership.guild_id
        AND claim.user_id = ownership.user_id
        AND claim.role_id = ownership.role_id
        AND claim.bot_added
  );

CREATE INDEX role_ownership_pending_idx
    ON role_ownership(operation) WHERE operation <> 'idle';
