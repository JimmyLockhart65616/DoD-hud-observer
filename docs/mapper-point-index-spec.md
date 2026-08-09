# Map request: set `point_index` on the control points

**For the maintainers of `dod_saints2_b3e`, `dod_donner` and `dod_merderet`.**
Contact: KTP League / DoD HUD Observer. Everything here is a small entity edit — no
geometry, lighting or gameplay change is being asked for. Each map has its own section
below; you only need the one for yours.

---

## What we need

Every `dod_control_point` entity in the map carries a `point_index` keyvalue. On both
maps it is currently set to **`-1`** on every control point.

We need it set to **distinct whole numbers `1..N`, running allies → axis** — that is,
`1` on the flag nearest the Allied spawn, counting up to `N` on the flag nearest the Axis
spawn, with the contested middle flag in between.

The exact values per map are in the tables below.

## Why

DoD's own HUD orders the flags correctly, but it derives that order internally. Anything
reading the map from outside the game — our live broadcast overlay, and any stats tool
built on the AMX Mod X DoD module — has to recover the order from the map file, and
`point_index` is the only field that carries it.

With every value at `-1` there is nothing to read, so the tooling falls back to the order
the entities happen to appear in the BSP. On both of your maps that order is different
from the real one, so flag **names get attached to the wrong flags**. On `dod_saints2_b3e`
three of the five are wrong — the centre bridge is announced as "Allied 2nd" — and on
`dod_donner` all five are wrong.

That reaches live broadcast: cap announcements, the kill feed, the scoreboard and the
casters' reference screen all name the wrong flag. We currently correct it with a
hardcoded per-map fix on our side, which we would like to retire in favour of the map
simply being right.

---

## `dod_saints2_b3e`

Five `dod_control_point` entities. Listed in the order they appear in the map file, with
their current `origin` so you can identify them unambiguously:

| # | `point_name` | `targetname` | `origin` | **set `point_index` to** |
|---|---|---|---|---|
| 0 | The Bridge | `flagmid` | `432 160 -68` | **3** |
| 1 | Allied 1st | `allied 1st` | `2014 -586 -236` | **1** |
| 2 | Allied 2nd | `Allied 2nd` | `992 972 -230` | **2** |
| 3 | Axis 2nd | `Axis 2nd` | `-636 1520 -236` | **4** |
| 4 | Axis 1st | `Axis 1st` | `-1680 796 -228` | **5** |

Giving the order: `Allied 1st → Allied 2nd → The Bridge → Axis 2nd → Axis 1st`.

The Bridge is the `point_team_points 2` double-cap and **must** end up on `point_index 3`
(the middle). We have confirmed that independently from 65 recorded league matches, so
that one is not in doubt.

## `dod_donner`

Five `dod_control_point` entities. Only the centre flag has a `targetname`, so use the
`origin` to identify them:

| # | `point_name` | `targetname` | `origin` | **set `point_index` to** |
|---|---|---|---|---|
| 0 | `POINT_DONNER_AXISHQ` | — | `1760 -240 -120` | **5** |
| 1 | `POINT_AXISSTREET` | — | `1088 -1176 -112` | **4** |
| 2 | `POINT_ALLIEDSTREET` | — | `-2096 -992 -128` | **2** |
| 3 | `POINT_DONNER_ALLIEDHQ` | — | `-2624 -1920 -128` | **1** |
| 4 | `POINT_DONNER_MAINSTREET` | `mainstreetflag` | `-580 -117 -36` | **3** |

Giving the order: `ALLIEDHQ → ALLIEDSTREET → MAINSTREET → AXISSTREET → AXISHQ`.

MainStreet is the double-cap centre and **must** end up on `point_index 3`.

## `dod_merderet` — a different fix

This one isn't a numbering omission, it's a leftover entity. The map has **six**
`dod_control_point` entities where the map plays five flags, and the sixth is a dead
duplicate of the bridge:

| # | `point_name` | `targetname` | `origin` | `point_index` |
|---|---|---|---|---|
| 0 | `POINT_AXISSTREET` | `flag 4` | `882 2329 -3101` | 4 |
| 1 | `POINT_BRIDGE` | `flag 1` | `296 772 -3012` | 3 |
| 2 | `POINT_MERDERET_STRONGHOLD` | `flag 5` | `382 -1373 -2845` | 2 |
| 3 | `POINT_FIELD` | `flag 5` | `-1142 2859 -2992` | 5 |
| 4 | `POINT_MERDERET_CHURCHSQUARE` | `flag 7` | `940 -2157 -2970` | **3** ← clash |
| 5 | `POINT_BRIDGE` | `flag 1` | `264 356 -3170` | **3** ← ghost |

**Entity #5 looks like a leftover.** It carries `point_group "asdf"`, all three of its
models are `models/mapmodels/null.mdl`, `point_points_for_cap 0`, and no
`point_team_points` at all — so it is invisible and scores nothing. But it duplicates the
real bridge's `targetname` (`flag 1`), its `point_index` (3) and its HUD icons (6/7/8),
and the `flagbridge` capture area targets `flag 1` — which now matches two entities.

**Two changes:**

1. **Delete entity #5** (the one at `264 356 -3170` with `point_group "asdf"`).
2. **Change `POINT_MERDERET_CHURCHSQUARE` from `point_index 3` to `point_index 1`.**

Everything else is already correct. With those two edits the five real flags read
`1,2,3,4,5` as `CHURCHSQUARE → STRONGHOLD → BRIDGE → AXISSTREET → FIELD`, which matches
their physical order along the map — their `y` coordinates are already monotonic in that
sequence (`-2157, -1373, 772, 2329, 2859`), so the existing `2,3,4,5` values are right and
only the church square is wrong.

Minor, cosmetic, entirely optional: `POINT_MERDERET_STRONGHOLD` and `POINT_FIELD` are
both named `flag 5`. Nothing targets that name so it breaks nothing, but renaming one
would make the map easier to work on.

---

## The one thing we'd like you to check

**Load the map and look at the flag icons on your own HUD, left to right — we believe
that order is the correct numbering.** The game sends each flag to the client tagged with
the same internal index we're trying to recover, and draws them in that order, so the HUD
should be a direct readout of it. If it disagrees with our table, please tell us rather
than following the table: either way that's information we can't get from the map file
alone, and we'll confirm it against match data once the map is in rotation.

We derive the tables from flag positions, which is reliable when the flags sit in a line
but cannot separate two flags at similar depth that are offset sideways. Specifically:

- **`dod_saints2_b3e`** — we are confident about The Bridge (proven from match data). The
  pair we would most like you to confirm is **Allied 1st vs Allied 2nd**: which of those
  two is nearer the Allied spawn, i.e. which should be `1`?
- **`dod_donner`** — please confirm both **ALLIEDHQ vs ALLIEDSTREET** and **AXISSTREET vs
  AXISHQ**. We believe each HQ is the flag closest to its own team's spawn (so ALLIEDHQ
  is `1` and AXISHQ is `5`), but donner has never been played on our overlay, so we have
  no match data to check that against.

---

## Rules the values must follow

These are enforced by the tool that reads the map, and breaking any of them silently puts
the map back to the broken state with **no error message** — so they're worth a glance:

1. **Every** `dod_control_point` needs a value. If even one is left at `-1`, the whole
   reorder is discarded and nothing improves. (Another map in our pool, `dod_northbound`,
   fails exactly this way.)
2. Values must be **0 or greater**. `-1` is treated as "not set".
3. Values must be **all different**. Sorting is by value only, so two flags sharing a
   number are left in arbitrary order relative to each other. `1,2,3,4,5` is the
   convention used by the maps that work.
4. Please **don't move the flags**. The `origin` values are used to match map entities to
   in-game entities; if a flag moves, the match fails and the ordering is discarded.
5. Please leave `point_default_owner`, `point_team_points` and the `dod_capture_area`
   entities alone — we use them as cross-checks.

## Making the change

Either set the property on the `dod_control_point` entities in Hammer and recompile, or —
if you'd rather not rebuild — rewrite just the entity lump in place with `ripent`
(`ripent -export map.bsp`, edit the `.ent` text file, `ripent -import map.bsp`). The
entity lump is plain text and `ripent` leaves geometry, lighting and visibility untouched,
so it's the lower-risk option if the map is otherwise final.

## Please ship it under a new filename

Any edit changes the BSP checksum, so a same-name re-release would mismatch clients that
still have the old file. A new name (`dod_saints2_b4`, or similar) avoids that entirely.
It also means nothing has to be coordinated on our side — our existing per-map correction
stays attached to the old name, and the new map is picked up correctly the moment it
lands.

For **`dod_donner`** specifically: it's a stock Valve map, so this necessarily becomes a
renamed community variant, with the league-wide redownload that implies. That's a call for
the league rather than a small fix — if it isn't worth it, say so and we'll simply keep
our existing correction for stock donner. Nothing breaks either way.

---

## Appendix A — other maps in the KTP pool with the same defect

Found while auditing all 33 maps in the current pool (`scripts/cp-entity-dump.py`).
Listed for completeness; not part of this request.

| map | state |
|---|---|
| `dod_saints2_b2` | Same as b3e — all five at `-1`. Same fix, same values. |
| `dod_northbound` | Four of five CPs set to `point_index 1` and the fifth (`Central Area`) at `-1`. Both failure modes at once. Renders correctly today only by luck of entity order. Correct values are simply `1,2,3,4,5` in file order — the entity names already spell out the intended order. |

`dod_merderet` is also affected and has its own section above — its fix is a deletion
plus one renumber, not a numbering pass.

The other 20 objective maps in the pool are correctly numbered and need nothing.

## Appendix B — how the tables were derived

- `scripts/cp-entity-dump.py <map.bsp>` reads the BSP entity lump directly and prints the
  table above, including its own confidence warnings.
- The position-based ordering it suggests was validated against the maps in our pool that
  already ship correct values. It reproduced `dod_kalt` exactly, and got `dod_armory_b6`,
  `dod_avalanche` and `dod_solitude2` wrong — in every case by swapping a pair of flags at
  similar depth but offset sideways. Hence the explicit request above to confirm those
  pairs against the in-game HUD rather than trusting the derivation.
- `dod_saints2_b3e`'s bridge position is additionally confirmed from 65 recorded league
  matches three independent ways (capture-area correlation, the `+2` score delta unique to
  the double-cap flag, and default-ownership at round start). See
  [dodx-cp-index-space-findings.md](dodx-cp-index-space-findings.md).
