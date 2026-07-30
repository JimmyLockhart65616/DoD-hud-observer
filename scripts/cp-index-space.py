#!/usr/bin/env python3
"""Derive a map's dodx-array -> DLL-cp_index permutation from recorded matches.

Needed when dodx's BSP `point_index` reorder can't run, which leaves dodx's CP
array in entity-spawn order while `dod_control_point_captured` keeps handing us
DLL indices. See `g_cp_dodx_of_dll` in KTPHudObserver.sma and
docs/dodx-cp-index-space-findings.md.

You need an entry for a map when its server log shows either:
    [DODX] BSP parse returned 0 CPs — using entity scan order
    [DODX] BSP CP count (N) != entity scan count (M), skipping reorder

Then play one match on it and run:

    python3 scripts/cp-index-space.py <matches_dir> <map_name>

On the prod data server that is:

    sudo python3 cp-index-space.py /opt/hud-observer/matches dod_saints2_b3e

Two independent signals are reported:

  1. SCORE DELTA — most competitive DoD maps give the contested middle CP
     `point_team_points=2` and every other CP 1. The flag_id whose captures are
     followed by a +2 team-score delta is that CP, in the DLL's index space.
  2. FIRST-CAPTURE OWNER — the engine resets flags to their default owners at
     round start, which we record as a capture. So the first-capture owner per
     flag_id reveals default ownership, and the allies/neutral/axis pattern pins
     the rest of the ordering against the map's BSP.

Cross-check both against the BSP's `point_name` / `point_default_owner` /
`point_team_points` keys (in entity order) before trusting a permutation.
"""
import glob
import json
import os
import sys
from collections import Counter, defaultdict


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    root, want = sys.argv[1], sys.argv[2]

    names = {}
    delta_by_flag = defaultdict(Counter)
    first_owner = defaultdict(Counter)
    owner_split = defaultdict(Counter)
    matches = 0

    for meta_path in sorted(glob.glob(os.path.join(root, '*', 'metadata.json'))):
        try:
            with open(meta_path) as fh:
                meta = json.load(fh)
        except Exception:
            continue
        if want not in json.dumps(meta):
            continue
        ev = os.path.join(os.path.dirname(meta_path), 'events.jsonl')
        if not os.path.exists(ev):
            continue
        matches += 1

        events = []
        with open(ev, errors='replace') as fh:
            for line in fh:
                try:
                    events.append(json.loads(line))
                except Exception:
                    pass

        for e in events:
            if e.get('event') == 'flags_init':
                for fl in e.get('flags', []):
                    names[fl.get('flag_id')] = fl.get('flag_name')

        last = {'allies': None, 'axis': None}
        seen_first = set()
        for i, e in enumerate(events):
            t = e.get('event')
            if t in ('half_start', 'ktp_match_start'):
                last = {'allies': None, 'axis': None}
                seen_first = set()
            elif t == 'team_score':
                last = {'allies': e.get('allies_score'), 'axis': e.get('axis_score')}
            elif t == 'flag_captured':
                fid, owner = e.get('flag_id'), e.get('new_owner')
                owner_split[fid][owner] += 1
                if fid not in seen_first:
                    first_owner[fid][owner] += 1
                    seen_first.add(fid)
                before = last.get(owner)
                for j in range(i + 1, min(i + 40, len(events))):
                    if events[j].get('event') == 'team_score':
                        after = events[j].get(str(owner) + '_score')
                        if before is not None and after is not None:
                            delta_by_flag[fid][after - before] += 1
                        break

    if not matches:
        print(f"No recorded matches found for '{want}' under {root}")
        return 1

    print(f"=== {want} — {matches} recorded matches ===\n")
    print(f"{'id':>3} {'flag_name (as emitted)':<24} {'score deltas':<30} "
          f"{'first-cap owner':<22} owner split")
    for fid in sorted(k for k in names if k is not None):
        d = delta_by_flag.get(fid, Counter())
        ds = ', '.join(f"+{k}x{v}" for k, v in sorted(d.items(), key=lambda kv: -kv[1])[:4])
        fo = ', '.join(f"{k}x{v}" for k, v in first_owner.get(fid, Counter()).most_common())
        osp = ', '.join(f"{k}x{v}" for k, v in owner_split.get(fid, Counter()).most_common())
        print(f"{fid:>3} {str(names.get(fid)):<24} {ds:<30} {fo:<22} {osp}")

    # Rank by the +2 share of NON-ZERO deltas. A +0 delta just means no
    # team_score arrived between the capture and our lookahead (or it repeated),
    # and those dominate every flag, so including them buries the signal.
    print("\n+2 share of non-zero score deltas (highest = the "
          "point_team_points=2 CP):")
    ranked = []
    for fid in sorted(k for k in names if k is not None):
        d = delta_by_flag.get(fid, Counter())
        pos = sum(v for k, v in d.items() if isinstance(k, int) and k > 0)
        two = sum(v for k, v in d.items() if k == 2)
        share = (100.0 * two / pos) if pos else 0.0
        ranked.append((share, fid, two, pos))
    for share, fid, two, pos in sorted(ranked, reverse=True):
        print(f"  flag_id={fid}  {share:5.1f}%  ({two}/{pos})  "
              f"emitted as '{names.get(fid)}'")

    best = max(ranked)
    print(f"\n=> On a map with exactly one point_team_points=2 CP, that CP is "
          f"flag_id={best[1]} in the DLL's index space,")
    print(f"   regardless of the name currently emitted for it ('{names.get(best[1])}').")
    print("   Cross-check against the BSP's point_team_points keys before trusting it.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
