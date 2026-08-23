#!/usr/bin/env python3
"""How often did the two cap-break defects actually fire, on a real match?

No recording carries death coordinates, so CAP_BREAK_RADIUS itself cannot be
validated retroactively. What the stream CAN settle is how often each defect had
the opportunity to fire.

  BUG 2 (stale capping-team read) -- DIRECT.
    g_flag_capping_team[] is written only by the 0.5s zone poll, so the true
    capture start precedes flag_cap_started by up to one poll. A kill of the
    capping team inside that gap read capping_team == 0 and queued nothing.

  BUG 1 (no proximity gate) -- PER-KILL LOWER BOUND.
    The old gate queued a killer for ANY death of a capping-team player while a
    cap was live. If the zone count for that team on that flag is ZERO at the
    moment of the kill, the victim provably was not standing in the zone, so the
    killer entered the FIFO wrongly. Zero is the only occupancy that proves
    absence from counts alone, which makes this a floor: deaths at count >= 1
    may also have been off-point and are not counted here.

    python3 capbreak-retro.py <events.jsonl(.gz)> [poll_interval]
"""
import bisect
import gzip
import json
import sys

POLL = 0.5
ALLIES, AXIS = 'allies', 'axis'


def load(path):
    if path.endswith('.json'):
        with open(path, 'rt', encoding='utf-8') as fh:
            d = json.load(fh)
        return d if isinstance(d, list) else d.get('events', [])
    op = gzip.open if path.endswith('.gz') else open
    out = []
    with op(path, 'rt', encoding='utf-8') as fh:
        for line in fh:
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def main():
    path = sys.argv[1]
    poll = float(sys.argv[2]) if len(sys.argv) > 2 else POLL
    evs = load(path)

    team = {}
    kills, zsamples, capev = [], [], []
    for e in evs:
        ev, t = e.get('event'), e.get('tick')
        if ev in ('player_connect', 'player_spawn', 'player_team_change'):
            if e.get('user_id') and e.get('team'):
                team[e['user_id']] = e['team']
        elif ev == 'kill' and e.get('kill_type') == 'normal' and t is not None:
            kills.append((t, team.get(e.get('victim_id')), e.get('victim_id'), e.get('killer_id')))
        elif ev == 'flag_zone_players' and t is not None:
            m = {z.get('flag_id'): (z.get('allies_count', 0), z.get('axis_count', 0))
                 for z in e.get('zones', [])}
            zsamples.append((t, m))
        elif ev in ('flag_cap_started', 'flag_cap_stopped', 'flag_captured') and t is not None:
            capev.append((t, ev, e.get('flag_id'), e.get('capping_team') or e.get('new_owner')))

    zsamples.sort(key=lambda r: r[0])
    ztimes = [r[0] for r in zsamples]
    capev.sort(key=lambda r: r[0])

    # Proper windows: walk chronologically, one open cap per flag at a time.
    open_cap, windows = {}, []
    for (t, ev, fid, tm) in capev:
        if ev == 'flag_cap_started':
            if fid in open_cap:                       # restart without a stop
                s, st = open_cap.pop(fid)
                windows.append((s, t, fid, st))
            open_cap[fid] = (t, tm)
        else:
            if fid in open_cap:
                s, st = open_cap.pop(fid)
                windows.append((s, t, fid, st))
    for fid, (s, st) in open_cap.items():
        windows.append((s, s + 30.0, fid, st))        # unterminated: bound at 30s

    def zone_at(t, fid, tm):
        """In-zone count for `tm` on `fid` at the latest sample at or before t."""
        i = bisect.bisect_right(ztimes, t) - 1
        if i < 0:
            return None
        m = zsamples[i][1]
        if fid not in m:
            return None
        return m[fid][0 if tm == ALLIES else 1]

    print('events %d | normal kills %d | zone samples %d | cap windows %d'
          % (len(evs), len(kills), len(zsamples), len(windows)))
    durs = sorted(round(b - a, 1) for a, b, _f, _t in windows)
    print('window durations: min %.1fs  median %.1fs  max %.1fs\n'
          % (durs[0], durs[len(durs) // 2], durs[-1]))

    # ---- BUG 2 ----
    gap = [(fid, tm, round(ts - tk, 2))
           for (ts, _te, fid, tm) in windows
           for (tk, vt, _v, _k) in kills
           if tm in (ALLIES, AXIS) and vt == tm and ts - poll <= tk <= ts]
    print('BUG 2 -- capping-team kills in the %.1fs pre-detection gap:' % poll)
    print('  %d kills across %d of %d cap windows -- each queued NOTHING\n'
          % (len(gap), len({g[0] for g in gap}), len(windows)))

    # ---- BUG 1 ----
    considered = proven = 0
    per_flag = {}
    for (ts, te, fid, tm) in windows:
        if tm not in (ALLIES, AXIS):
            continue
        for (tk, vt, _v, _k) in kills:
            if vt != tm or not (ts <= tk <= te):
                continue
            considered += 1
            n = zone_at(tk, fid, tm)
            if n == 0:
                proven += 1
                per_flag[fid] = per_flag.get(fid, 0) + 1

    print('BUG 1 -- capping-team deaths during a live cap: %d' % considered)
    print('  of those, zone count for that team was ZERO at the kill: %d' % proven)
    if considered:
        print('  => at least %.0f%% of queued candidates were provably off-point'
              % (100.0 * proven / considered))
    for fid, n in sorted(per_flag.items()):
        print('     flag %s: %d' % (fid, n))
    print('\n  (floor only -- deaths at occupancy >= 1 may also be off-point;')
    print('   counts cannot tell WHICH players were in the zone.)')


if __name__ == '__main__':
    main()
