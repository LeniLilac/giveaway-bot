# Public draw proof, `lilac-weighted-v2`

This document is normative for new draws using proof version
`lilac-weighted-v2`. The portable implementation in `packages/proof` is the
single selection implementation used by the worker. Draws created before the
v2 migration retain `lilac-weighted-v1`; their compatibility rules are in
section 8.

## 1. Eligibility snapshot

At giveaway end, active entries are evaluated again:

1. The Discord account must still be in the guild.
2. Bot accounts are excluded.
3. Required roles use the recorded `all` or `one` mode.
4. On a reroll, every winner from every prior completed draw is excluded.
5. Entries joined after the persisted closure timestamp are excluded.
6. Weight equals one plus every matching role bonus and must remain a positive
   JavaScript safe integer.

Message-count and role requirements are checked both at admission and when the
draw snapshot is prepared. A `since_start` message requirement uses the
persisted actual start time, not the originally scheduled time; a failed or
inconclusive Discord search aborts the whole snapshot.

## 2. Private-to-public participant identity

For each giveaway, Lilac derives a stable, non-reversible participant identity:

```text
participant_id = lowercase_hex(HMAC-SHA256(
  privacy_secret,
  UTF8("lilac-proof-id/v2:" || giveaway_id || ":" || discord_user_id)
))
```

The secret and Discord ID are not proof inputs exposed publicly. The resulting
`participantId` is. Scoping by giveaway prevents public cross-giveaway
correlation while keeping reroll exclusion stable within one giveaway.

## 3. Canonical candidates

Entries are initially ordered by:

1. `joinedAt` ascending
2. Discord user ID ascending by Unicode string comparison when join times tie

The worker stores this as a contiguous ordinal beginning at zero. Public v2
verification orders records by ordinal and verifies that the sequence is
contiguous. Each record then becomes an object whose keys are inserted in this
exact order:

```json
{"participantId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","joinedAt":"2026-01-01T00:00:01.000Z","weight":2}
```

The ordinal is ordering metadata and is not serialized into the snapshot.
The canonical snapshot is `JSON.stringify` of the array with no extra
whitespace. `candidate_hash` is lowercase hexadecimal SHA-256 of its UTF-8
bytes. The database prevents canonical fields from being updated afterward.

The fixed three-candidate fixture in `packages/proof/src/index.test.ts` has
snapshot hash:

```text
904749d51e1de2dc15a0a21867a03e532096edb596d96257efa33001e9edadfc
```

With randomness `ab` repeated 32 times, draw number 1, and weights 2, 4, 1,
the winner participant prefixes are `b`, `c`, `a`.

## 4. Future, authenticated drand commitment

Lilac pins the drand chain hash, public key, period, genesis time, and signature
scheme outside the relay. Relay `/info` data must match every pinned value.
Every beacon is BLS-verified with the official maintained drand client, and the
worker additionally confirms `randomness = SHA256(signature_bytes)`.

For target Unix time `target`, the first round whose emission is not earlier
than the target is:

```text
round = ceil((target - genesis_time) / period) + 1
round_time = genesis_time + (round - 1) * period
```

Round 1 is used when the target is at or before genesis. Candidate rows are
inserted in batches, and the transaction uses PostgreSQL `clock_timestamp()` to
verify immediately before commit that the beacon remains at least 15 seconds
in the future. Lilac normally chooses a 20-second publication cushion. A draw
cannot complete until Discord publication succeeds and a second database-clock
guard confirms at least 15 seconds remain. If publication is delayed, the
unpublished draw is moved to a later round before it can complete.

Completion fetches the draw's committed chain, not whatever chain happens to be
configured later. A configuration mismatch fails closed.

## 5. Seed

Decode `drand_randomness` and `candidate_hash` from hexadecimal. Let
`draw_number_utf8` be the decimal draw number with no padding.

```text
seed = SHA256(
  drand_randomness_bytes ||
  candidate_hash_bytes ||
  UTF8(draw_number_utf8)
)
```

## 6. Unbiased weighted selection

Selection is without replacement. For winner index `i` starting at zero:

```text
digest = SHA256(seed || uint64_be(i) || uint32_be(attempt))
```

Interpret `digest` as an unsigned 256-bit big-endian integer `value`. Let
`total` be the sum of remaining weights and:

```text
range = 2^256
ceiling = range - (range mod total)
```

If `value >= ceiling`, increment `attempt` and hash again. Otherwise set
`target = value mod total`. Walk candidates in canonical order, subtracting
weights until `target` lies inside a candidate's interval. Select and remove
that candidate. Repeat until the requested winner count or candidate set is
exhausted. Rejection sampling prevents modulo bias.

## 7. Rerolls and privacy

A reroll creates a numbered draw and a new future drand commitment. It uses the
current entry and role state but excludes proof identities from every prior
completed draw. Privacy deletion may redact `user_id`, usernames, and profile
fields, but it never changes v2 `proof_id`, candidate order, join time, weight,
or candidate hash. Therefore a deleted prior winner remains excluded and the
published v2 snapshot remains independently reproducible.

## 8. Legacy v1 compatibility

`lilac-weighted-v1` serialized `{userId, joinedAt, weight}` and ordered tied
join times by `userId`. Existing rows retain this version and the worker uses
the v1 canonicalizer and selector when completing an in-flight legacy draw.
Privacy deletion is deferred while such a draw is awaiting its beacon.

Once a v1 draw is complete, deletion may redact its canonical Discord ID. The
draw is then marked with `proof_redacted_at` and public consumers must report it
as `redacted_unverifiable`; they must not claim its post-redaction candidate
list reproduces the old hash. A stable scoped proof ID is retained for reroll
exclusion, but it does not retroactively change the v1 commitment.
