# `match_end` summary truncation — findings

**Status:** open, cause not determined. Filed as a PR because issues are disabled on this repo.
**Reported by:** KTP (afraznein), 2026-08-30. Investigated 2026-08-29; headline re-measured
independently before filing.

⚠️ **No fix is proposed here, deliberately.** The failing predicate was not identified, and guessing
at it in someone else's source is how a wrong fix ships. Everything below is measurement.

---

## What happens

The player summary emitted from `ktp_match_end` arrives **truncated**, on the live fleet, today.
It is not a LAN artifact.

Across the 60 most recent recordings in `/opt/hud-observer/matches`:

| event | complete payloads | median players |
|---|---|---|
| `round_end` | **249 of 257** | 12 |
| `half_end` | **49 of 59** | 12 |
| **`match_end`** | **1 of 56** | **3 of 12** |

**Only the summary fired from `ktp_match_end` is short.** That specificity is the finding — the same
emit path produces full rosters seconds earlier.

## The control that matters is inside a single match

`1.3-6648-CHI1` emitted `round_end n=12` **twice** in half 2 (ticks 442 and 527), then `match_end
n=3` at tick 1335. Same function, same server, same buffer, thirteen minutes apart.

## The receiving side is exonerated, exactly

Stored rows equal payload entries on the nose:

- half 1 — `1905 + 1140 = 3045` stored vs `1930 + 1115 = 3045` emitted
- half 2 — `2839` stored vs `2839` emitted

and the raw `events.jsonl` carries `n_players=1` in the payload itself. **The plugin sent short
payloads; nothing downstream dropped them.**

## 🎁 The clue: exclusion is a STABLE PER-PLAYER property, not random

This is the part worth starting from.

- `STEAM_0:0:123285` — excluded **18 of 18**
- `STEAM_0:1:25292511` — included **17 of 17**

Under a uniform ~32% drop rate, 0-for-18 is on the order of **1e-9**. Whatever the predicate is, it
is a property of the player, evaluated per player, and stable across matches.

⚠️ **And the plugin's own state model disagrees with the outcome:** there are **zero**
`player_disconnect` events in half 2 anywhere (control: **1178** in half 1), and `match_phase`
reports `live` six seconds before the summary. By its own bookkeeping every player is present and
connected at the moment the short payload is built.

## Ruled out — please don't re-derive these

| hypothesis | why it fails |
|---|---|
| **buffer overflow** | `break` yields a **prefix**; survivors are a scattered slot-order subset. `n=1` payloads are ~480 B against a 3072 threshold. It explains the `half_end n=11` cases only. |
| **alive vs dead** | the lone survivor of `1785710044-KTP3` was the **last to die**, while 8 *alive* players were dropped. |
| **team** | survivors split evenly across teams. |
| **post-play drain / timing** | lag is ~10 s regardless of `n`. |

## Impact on our side, and why we are not blocked on you

Recoverability is measured, not assumed: 19 of 21 LAN matches reconstruct approximately from the
last `player_score` event per `(match, half, user)` — **exact on all 13 fields for 734 of 976 (75%)**,
the error being 13–70 s of staleness. `1785645287-KTP1` recovers 11 of 12.

Any reconstruction we attempt is testable against the 976 surviving half-2 rows before anything is
written, so we can proceed without a fix. **We would rather have the cause.**

## A second, unrelated failure seen in the same data

`1785715972-KTP1` recovers **nothing** — its event stream stopped mid-half-1 while HLStatsX kept
recording for 20 more minutes. POSTs appear to be fire-and-forget with no retry or spool, so a
transport hiccup ends the stream silently. Noting it here rather than filing separately; say the word
and we will split it out.

---

*Filed against `main` at the time of writing. Happy to re-measure anything on request — the raw
recordings are retained on our side.*
