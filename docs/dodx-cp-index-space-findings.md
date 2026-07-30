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

Scanning all 33 maps in prod `ktp_maps.ini`:

- **20 fine** — every CP has `point_index`; reorder runs.
- **3 affected** — `dod_saints2_b3e`, `dod_saints2_b2`, and **`dod_donner`** (a
  stock map; ships `point_index=-1` on all 5 CPs, and its spawn order is fully
  scrambled relative to geography, so all 5 names are wrong).
- **1 affected differently** — `dod_northbound` has 4 of 5 CPs with
  `point_index` (all `=1`) plus one absent, so `bspCount != mObjects.count` and
  the reorder is skipped via the *other* branch. Its spawn order happens to
  match the DLL's, so it is correct by luck.

### Suggested fix

When the BSP reorder can't run, fall back to ordering `mObjects` by CP origin
along the dominant axis, oriented allies→axis (origins are already read from
`pEdict->v.origin`). On `dod_saints2_b3e` that reproduces the empirically proven
permutation exactly. Pair it with the already-planned "skip `point_index < 1`
pseudo-CPs" change, which independently fixes the `dod_glider` count mismatch.

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
default-owned flags (`SetObj` corrects it once captures start). Both smell like a
one-int shift in `pd_dcp` around offset 90–94 on Linux; the real `default_owner`
is sitting where `flag_id` is declared.

Worth re-deriving the whole `pd_dcp` tail against the DLL before building the
dedupe on any field in it.

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
