ALTER TABLE draws ADD COLUMN requested_winner_count integer;

UPDATE draws d
SET requested_winner_count = g.winner_count
FROM giveaways g
WHERE g.id = d.giveaway_id;

ALTER TABLE draws
    ALTER COLUMN requested_winner_count SET NOT NULL,
    ADD CONSTRAINT draws_requested_winner_count_positive
        CHECK (requested_winner_count > 0);

CREATE UNIQUE INDEX draws_one_pending_per_giveaway_idx
    ON draws(giveaway_id)
    WHERE status IN ('awaiting_beacon', 'drawing');
