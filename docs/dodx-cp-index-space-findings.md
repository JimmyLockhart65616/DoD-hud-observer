# dodx CP index-space findings (for KTPAMXX issue #5)

Investigated 2026-07-30 from a live-broadcast symptom on `dod_saints2_b3e`: the
HUD overlay showed flags as `The Bridge | Allied 1st | Allied 2nd | Axis 2nd |
Axis 1st`, with the bridge first when it is geographically the middle flag.

Everything below was reproduced locally on a KTP-ReHLDS + KTPAMXX extension-mode
container running the exact prod BSP (`md5 bc236ca382584c7ce24b58d129189d81`),
and corroborated against 65 recorded prod matches.

**TL;DR — three findings.** (1) The BSP `point_index` reorder silently no-ops on
maps whose CPs carry no usable `point_index`, and that leaves `CP_name` attached
to the wrong CP, not merely in an odd order. (2) `pd_dcp.flag_id` is misaligned:
it reads the CP's `default_owner`, which invalidates the planned
dedupe-by-`flag_id` fix. (3) The `InitObj` DLL-order reorder in `usermsg.cpp` is
unreachable in extension mode, so there is no fallback when (1) happens.

**Update 2026-08-05.** Finding 2 is now pinned to an exact cause — the Linux
`pd_dcp` branch is one `int` short, confirmed against AMXX's own published
`CControlPoint` offsets — and that makes it the **recommended fix for all three**:
correcting it exposes the DLL's real `m_iIndex` on entity pdata, which is the
authoritative `cp_index` the other two findings are trying to recover by proxy.
Also added: a measured warning against the geometric fallback originally
suggested for finding 1 (it reproduces only 1 of 4 backtested maps), and one
more affected map, `dod_merderet`. Map-side remediation for the affected maps is
specified in [mapper-point-index-spec.md](mapper-point-index-spec.md).

---

## 1. `point_index`-less maps silently lose CP identity (not just order)

`DODX_ReadBSPPointIndices` keeps only `point_index >= 0` (default `-1`), and the
reorder is gated on `bspCount == mObjects.count`. On a map where **no** CP
carries a usable `point_index`, `bspCount` is `0`, the gate fails, and because
`bspCount > 0` is also false it falls to the quiet `else`:

```
[DODX] BSP: Parsed dod_saints2_b3e — 5 dod_control_point, 0 with point_index
[DODX] BSP parse returned 0 CPs — using entity scan order
[DODX]   CP[0] point_index=0 owner=0 targetname='flagmid'    netname='The Bridge'
[DODX]   CP[1] point_index=1 owner=0 targetname='allied 1st' netname='Allied 1st'
[DODX]   CP[2] point_index=1 owner=0 targetname='Allied 2nd' netname='Allied 2nd'
[DODX]   CP[3] point_index=2 owner=0 targetname='Axis 2nd'   netname='Axis 2nd'
[DODX]   CP[4] point_index=2 owner=0 targetname='Axis 1st'   netname='Axis 1st'
```

`mObjects` therefore stays in entity-scan order while the DLL's `cp_index` (what
`dod_control_point_captured` / `SetObj` use, and what the game's own HUD uses)
is ordered allies→axis. The two diverge:

| DLL cp_index | real flag | `mObjects` slot | `CP_name` returns |
|---|---|---|---|
| 0 | Allied 1st | 1 | `The Bridge` |
| 1 | Allied 2nd | 2 | `Allied 1st` |
| 2 | **The Bridge** | 0 | `Allied 2nd` |
| 3 | Axis 2nd | 3 | `Axis 2nd` |
| 4 | Axis 1st | 4 | `Axis 1st` |

So any consumer that takes a `cp_index` from a forward and asks dodx for that
CP's name gets the **wrong flag's name** — here on 3 of 5 flags.

### Evidence (65 prod `dod_saints2_b3e` matches)

`dod_saints2_b3e` has exactly **one** `dod_capture_area` (targeting `flagmid`,
`area_*_numcap=2`, `area_time_to_cap=4`). So every capture-area state change is
the real bridge, and it is observed in dodx's array space, while
`dod_control_point_captured` arrives in DLL space. Correlating the two (30s
window, 1094 samples):

```
capture-area cap-start on dodx slot 0 (the bridge) completes as cp_index:
  cp_index=2  678  (62.0%)   <- CP_name says 'Allied 2nd'
  cp_index=1  137  (12.5%)
  cp_index=0   29  ( 2.7%)   <- CP_name says 'The Bridge'
  cp_index=3  101  ( 9.2%)
  cp_index=4   23  ( 2.1%)
```

Two independent confirmations of the same mapping:

- **Score delta.** Only the bridge has `point_team_points=2`; every other CP is
  worth 1. `cp_index=2` is the index whose captures are followed by a **+2**
  team-score delta (292 occurrences, vs 46 / 21 / 4 on the others and none in
  `cp_index=0`'s top deltas).
- **Default ownership.** The engine's reset-to-default at round start gives a
  first-capture owner per index of `allies, allies, mixed, axis, axis` —
  matching the real default owners `[allies, allies, neutral, axis, axis]`, i.e.
  the allies→axis order, not the spawn order.

### Fleet scope

Re-audited 2026-08-05 with `scripts/cp-entity-dump.py` against every map in prod
`ktp_maps.ini` (33 pool entries; 24 objective BSPs installed on the Denver host,
9 not present there):

- **20 fine** — every CP has a distinct `point_index`; reorder runs.
- **3 affected, no usable index** — `dod_saints2_b3e`, `dod_saints2_b2` and
  **`dod_donner`** (a stock map). All three ship `point_index` **explicitly set
  to `-1`** on every CP — the key is present, just unusable — and their spawn
  order is scrambled relative to geography, so names land on the wrong flags.
- **1 affected, count mismatch** — `dod_northbound` has 4 of 5 CPs carrying
  `point_index` (all `=1`) plus one absent, so `bspCount != mObjects.count` and
  the reorder is skipped via the *other* branch. Its spawn order happens to
  match the DLL's, so it is correct by luck.
- **1 affected, duplicate indices (NEW)** — `dod_merderet` has **6**
  `dod_control_point` entities with indices `[4,3,2,5,3,3]`. `bspCount ==
  mObjects.count`, so the gate *passes* and the reorder runs, but the three CPs
  sharing `3` are only order-preserved, not ordered. Two of them are both named
  `POINT_BRIDGE` (`296 772 -3012` and `264 356 -3170`, the second with no
  `point_team_points`) — i.e. a ghost/leftover CP. This is the map-side root
  cause of the identity drift that issue #5's dedupe-by-`flag_id` plan was
  trying to work around.

### Suggested fix — and a measured warning about the obvious one

The tempting fallback is: when the BSP reorder can't run, order `mObjects` by CP
origin along the dominant axis, oriented allies→axis (origins are already read
from `pEdict->v.origin`). On `dod_saints2_b3e` that reproduces the empirically
proven permutation exactly.

**Do not ship that as a blind fallback.** Backtesting it against the pool maps
that already carry correct `point_index` values (the only available ground
truth) it reproduced **1 of 4**:

| map | geometric order vs shipped |
|---|---|
| `dod_kalt` | MATCH (flags genuinely collinear) |
| `dod_armory_b6` | DIFFER — swaps `Warehouse` / `The Bridge` |
| `dod_avalanche` | DIFFER — swaps `ALLIEDSTREET` / `ALLIEDGUNPOSITION` |
| `dod_solitude2` | DIFFER — swaps `Church` / `Grassy Knoll` |

The failure mode is consistent and predictable: the projection cannot separate
two flags at similar *depth* that are offset *sideways* — i.e. any map with a
side/flank objective. `scripts/cp-entity-dump.py` now detects and reports those
pairs explicitly rather than silently guessing.

So a geometric fallback would trade a loud, detectable breakage (today: names
obviously wrong on 3 maps) for a quiet one (wrong on side-flag maps, plausible
enough to go unnoticed). Prefer the `pd_dcp` fix in finding 2 below, which is
exact; failing that, keep the per-map allowlist, which is at least evidence-backed.

---

## 2. `pd_dcp.flag_id` is misaligned — it reads `default_owner`

This one matters because the current plan for the hard half of issue #5 is to
**dedupe scanned entities by `cpd.flag_id`**. That field is not a flag identity.

`moduleconfig.cpp` does `mObjects.obj[idx].index = cpd.flag_id;`. Predicting the
sequence from each BSP's `point_default_owner` and comparing to the logged
`index` values matches exactly on two independent maps:

| map | BSP `point_default_owner` (spawn order) | dodx `index` |
|---|---|---|
| `dod_saints2_b3e` | `absent(0), 1, 1, 2, 2` | `0, 1, 1, 2, 2` |
| `dod_donner` | `2, 2, 1, 1, absent(0)` | `2, 2, 1, 1, 0` |

So `flag_id` is the **owning team** (0 neutral / 1 allies / 2 axis). Deduping a
5-flag map by it would collapse it to at most 3 entries — on
`dod_saints2_b3e` it would drop `Allied 2nd` and `Axis 1st` entirely.

Related, same struct region: `cpd.owner` reads a field that is `0` for every CP,
so `CP_owner` reports **neutral for all flags at map load** even on maps with
default-owned flags (`SetObj` corrects it once captures start).

### Confirmed 2026-08-05: the Linux `pd_dcp` branch is exactly one int short

Not a smell — the offsets settle it. `pd_dcp` (`dodx.h:182-249`) is byte-perfect
on Windows: walking the struct as 4-byte words puts `owner` at word 90 (byte
360), `default_owner` at 372 and `flag_id` at 376, and
`gamedata/common.games/entities.games/dod/offsets-ccontrolpoint.txt` gives
`m_iTeam` 360, `m_iDefaultOwner` 372, `m_iIndex` 376. Exact match.

The Linux/Apple branch (`dodx.h:211-216`) inserts **four** extra ints where it
needs **five**, so from `owner` onward every Linux read is 4 bytes early:

| `pd_dcp` field | struct byte (linux) | gamedata (linux) | actually reads |
|---|---|---|---|
| `owner` | 372 | `m_iTeam` **376** | the field below it → always 0 |
| `default_owner` | 384 | `m_iDefaultOwner` **388** | — |
| `flag_id` | 388 | `m_iIndex` **392** | **`m_iDefaultOwner`** |
| `pointvalue` | 392 | `m_iPointValue` **396** | **`m_iIndex`** |

The third row is exactly the empirical result above — `flag_id` returning the
default owner — derived independently. Two derivations agreeing from opposite
directions (BSP keyvalues vs published offsets) makes this as close to certain as
it gets without a debugger.

**The payoff.** One added `int` in the Linux/Apple branch and `flag_id` reads the
DLL's real `m_iIndex` — the authoritative `cp_index` — straight off entity pdata.
`mObjects.obj[idx].index` (`moduleconfig.cpp:1893`) then *is* the DLL index, and
the already-present-but-never-called `CObjective::Sort()` (`CMisc.cpp:827-842`,
a bubble sort on `obj[i].index` — the piece upstream dodfun calls and dodx
doesn't) aligns the two spaces exactly. That would retire the BSP parser, the
`point_index` dependency, the per-map allowlist in `KTPHudObserver.sma` and the
need to ask mappers to re-key their BSPs, all at once. It also fixes `CP_owner`
at map load for free.

Two things to settle before relying on it:

- **Read timing is unverified.** `m_iIndex` is stamped by `CControlPointMaster`
  during its activation pass; `DODX_InitCPFromEntities` runs at
  `OnPluginsLoaded`/`ServerActivate`. Whether the field is populated that early
  has to be measured, not assumed. (`m_iDefaultOwner` demonstrably *is*, since
  `flag_id` returns sane values today.)
- **Blast radius is the whole struct tail.** On Linux every field after `owner`
  is currently read 4 bytes early — `cap_time`, `icon_allies/axis/neutral`,
  `can_touch` included. Correcting the shift changes all of them together, so
  anything that has been quietly compensating for the wrong values changes
  behaviour. Canary before fleet.

---

## 3. The `InitObj` DLL-order reorder is unreachable in extension mode

`usermsg.cpp` `Client_InitObj` has a path that reorders `mObjects` into DLL order
whenever `newCount == mObjects.count`, gated by `g_cpOrderingFinalized` — which
would be the natural fix for finding 1. It can never fire: as
`DODX_OnInitObjMessage`'s own comment notes, `IMessageManager` does not dispatch
during `SV_ActivateServer`, so the full InitObj is missed. The only InitObj that
ever arrives carries `newCount=0`:

```
[DODX] InitObj: skipped (finalized=0, newCount=0, existing=5)
```

That repeats roughly every 20s, forever, on every map (observed on both
`dod_anzio` and `dod_saints2_b3e`). Net effect: **BSP `point_index` is the sole
CP-ordering source and has no fallback**, which is why finding 1 fails silently.

Either the `newCount=0` messages are a different InitObj variant worth filtering
out of the log, or the reorder block is dead code that should be removed so it
doesn't read as a working safety net.

---

## Reproduction notes

- Repro ran in a standalone container off `ktp-gameserver:latest` on the same
  docker network as the local stack, `MAP` pointed at the prod BSP.
- **GoldSrc `filesystem_stdio` cannot see single-file bind mounts** —
  `PF_IsMapValid_I` fails with `map change failed: '<map>' not found on server.`
  even though the file is present and `ls` finds it. The BSP has to be a real
  file in the container's own filesystem.
- The server needs the map's actual assets or it takes a `FATAL ERROR` (SIGSEGV):
  the WADs named in worldspawn's `wad` key plus everything in the map's `.res`.
- A round restart with **zero players** emits no `SetObj`, so the DLL's index
  space can't be read locally without a connected client — hence the analysis
  against recorded prod match streams.
