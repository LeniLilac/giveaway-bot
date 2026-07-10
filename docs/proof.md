# Public draw proof, `lilac-weighted-v1`

This document is normative for proof version `lilac-weighted-v1`.

## 1. Eligibility snapshot

At giveaway end, active entries are evaluated again:

1. The Discord account must still be in the guild.
2. Bot accounts are excluded.
3. Required roles use the recorded `all` or `one` mode.
4. On a reroll, every winner from every prior completed draw is excluded.
5. Weight equals one plus every matching role bonus.

Message-count requirements are admission requirements and are checked when joining. Role requirements are checked both at admission and draw time.

## 2. Canonical candidates

Eligible candidates are sorted by:

1. `joinedAt` ascending
2. `userId` ascending by Unicode string comparison when join times are equal

Each candidate becomes an object whose keys are inserted in this exact order:

```json
{"userId":"123","joinedAt":"2026-07-10T12:34:56.789Z","weight":3}
```

The canonical snapshot is `JSON.stringify` of the resulting array with no extra whitespace. `candidate_hash` is lowercase hexadecimal SHA-256 of the UTF-8 snapshot.

## 3. Future drand commitment

Lilac fetches the configured chain information and chooses the first Quicknet round at or after 15 seconds in the future:

```text
round = floor((target_unix_seconds - genesis_time) / period) + 1
```

The candidate hash, chain hash, round, and expected beacon time are persisted and posted before the beacon is available.

For Quicknet's unchained scheme, Lilac confirms:

```text
randomness = lowercase_hex(SHA256(signature_bytes))
```

Independent verifiers should additionally verify the BLS signature against the chain public key.

## 4. Seed

Decode `drand_randomness` and `candidate_hash` from hexadecimal. Let `draw_number_utf8` be the decimal draw number with no padding.

```text
seed = SHA256(
  drand_randomness_bytes ||
  candidate_hash_bytes ||
  UTF8(draw_number_utf8)
)
```

## 5. Unbiased weighted selection

Selection is without replacement. For winner index `i` starting at zero:

```text
digest = SHA256(
  seed ||
  uint64_be_hex(i) ||
  uint32_be_hex(attempt)
)
```

Interpret `digest` as an unsigned 256-bit big-endian integer `value`. Let `total` be the sum of remaining weights and:

```text
range = 2^256
ceiling = range - (range mod total)
```

If `value >= ceiling`, increment `attempt` and hash again. Otherwise `target = value mod total`. Walk candidates in canonical order, subtracting weights until `target` lies inside a candidate's weight interval. Select and remove that candidate. Repeat until the requested winner count or candidate set is exhausted.

This rejection step prevents modulo bias.

## 6. Rerolls

A reroll creates a new numbered draw and new future drand commitment. It uses the current active entries and role state, but excludes all user IDs found in any prior completed draw for the giveaway.

## 7. Redaction

A privacy deletion may replace a Discord user ID and profile snapshot with a `deleted:...` pseudonym. The original candidate hash remains as the historical commitment. The public API indicates the redacted candidate record; a verifier should treat the pre-redaction candidate hash as externally committed historical evidence.
