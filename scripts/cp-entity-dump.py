#!/usr/bin/env python3
"""Dump a GoldSrc BSP's control-point entities in entity-lump order.

Companion to cp-index-space.py. That script derives a map's DLL cp_index space
from *recorded matches*; this one reads the *authoritative source* — the BSP
entity lump — so the two can be cross-checked, and so a mapper can be handed an
exact per-entity table.

    python3 scripts/cp-entity-dump.py <map.bsp> [<map.bsp> ...]

The parse deliberately mirrors DODX_ReadBSPPointIndices in
KTPAMXX/modules/dod/dodx/moduleconfig.cpp so the verdict below matches what dodx
will actually do at map load:

  * lump 0 is the entity lump, and BSP version must be 30
  * `point_index` defaults to -1, and ONLY entries with `point_index >= 0` are
    kept — so an absent key and an explicit "-1" are identical
  * the reorder runs only when that kept-count equals the number of spawned
    dod_control_point entities; otherwise CP order silently stays entity-spawn
    order while dod_control_point_captured keeps handing out DLL indices, and
    every CP name is attached to the wrong flag

Background: docs/dodx-cp-index-space-findings.md and
docs/mapper-point-index-spec.md.
"""
import os
import struct
import sys

HEADER_LUMPS = 15
BSP_VERSION = 30

OWNER_NAMES = {'0': 'neutral', '1': 'allies', '2': 'axis'}

# The CP's HUD name lives in `point_name`, which the DLL copies to pev->netname
# at spawn — so it is empty in the lump but populated in DODX's runtime logs.
# On stock maps it is a titles.txt token (e.g. POINT_DONNER_AXISHQ).
NAME_KEY = 'point_name'


def read_entity_lump(path):
    """Return the entity lump as text, or raise ValueError."""
    with open(path, 'rb') as fh:
        header = fh.read(4 + HEADER_LUMPS * 8)
        if len(header) < 12:
            raise ValueError('file too short to be a BSP')
        version = struct.unpack_from('<i', header, 0)[0]
        if version != BSP_VERSION:
            raise ValueError('BSP version %d (expected %d)' % (version, BSP_VERSION))
        offset, length = struct.unpack_from('<ii', header, 4)
        if length <= 0 or length > 2 * 1024 * 1024:
            raise ValueError('entity lump length invalid (%d)' % length)
        fh.seek(offset)
        data = fh.read(length)
    if len(data) < length:
        raise ValueError('entity lump truncated')
    return data.split(b'\0', 1)[0].decode('latin-1')


def parse_entities(text):
    """Yield each entity block as a list of (key, value), in lump order.

    Keys can legitimately repeat, so this keeps a list rather than a dict.
    """
    pos, end = 0, len(text)
    while pos < end:
        while pos < end and text[pos] != '{':
            pos += 1
        if pos >= end:
            return
        pos += 1
        pairs = []
        while pos < end and text[pos] != '}':
            if text[pos] != '"':
                pos += 1
                continue
            pos += 1
            start = pos
            while pos < end and text[pos] != '"':
                pos += 1
            key = text[start:pos]
            pos += 1
            while pos < end and text[pos] in ' \t':
                pos += 1
            if pos >= end or text[pos] != '"':
                continue
            pos += 1
            start = pos
            while pos < end and text[pos] != '"':
                pos += 1
            pairs.append((key, text[start:pos]))
            pos += 1
        pos += 1
        yield pairs


def get(pairs, key, default=''):
    for k, v in pairs:
        if k == key:
            return v
    return default


def as_point_index(raw):
    """dodx uses atoi(), which yields 0 for unparseable input."""
    if raw == '':
        return -1, 'absent'
    try:
        return int(raw), raw
    except ValueError:
        return 0, '%r (atoi -> 0)' % raw


def geometric_order(cps):
    """Predict the allies->axis CP ordering from origins alone.

    This is the algorithm proposed as the dodx-side fallback in
    docs/dodx-cp-index-space-findings.md: project the CPs onto whichever
    horizontal axis they are most spread along, then orient that axis so it runs
    from the allied end to the axis end (using point_default_owner as the
    compass). Returns a list of lump indices in allies->axis order, or None if
    the origins or default owners can't settle it.
    """
    pts = []
    for pairs in cps:
        try:
            x, y, _z = (float(v) for v in get(pairs, 'origin').split()[:3])
        except (ValueError, IndexError):
            return None
        pts.append((x, y, get(pairs, 'point_default_owner', '0')))

    spread_x = max(p[0] for p in pts) - min(p[0] for p in pts)
    spread_y = max(p[1] for p in pts) - min(p[1] for p in pts)
    axis = 0 if spread_x >= spread_y else 1

    allied = [p[axis] for p in pts if p[2] == '1']
    axis_side = [p[axis] for p in pts if p[2] == '2']
    if not allied or not axis_side:
        return None

    # Orient so the allied end sorts first.
    ascending = (sum(allied) / len(allied)) < (sum(axis_side) / len(axis_side))
    order = sorted(range(len(pts)), key=lambda i: pts[i][axis],
                   reverse=not ascending)

    # Flag adjacent pairs the projection cannot honestly separate: two flags at
    # similar depth but offset sideways. Measured on the KTP pool, this is the
    # heuristic's only failure mode — it got dod_kalt (a collinear layout) right
    # and dod_armory_b6 / dod_avalanche / dod_solitude2 (each with a side flag)
    # wrong, in every case by swapping exactly such a pair.
    lateral = 1 - axis
    ambiguous = []
    for a, b in zip(order, order[1:]):
        along = abs(pts[a][axis] - pts[b][axis])
        across = abs(pts[a][lateral] - pts[b][lateral])
        if across > along:
            ambiguous.append((a, b))
    return order, ('x' if axis == 0 else 'y'), ascending, ambiguous


def label_of(pairs):
    return (get(pairs, NAME_KEY) or get(pairs, 'targetname') or '(unnamed)')


def dump(path):
    name = os.path.basename(path)
    print('=' * 78)
    print(name)
    print('=' * 78)

    try:
        text = read_entity_lump(path)
    except (OSError, ValueError) as exc:
        print('  ERROR: %s' % exc)
        return 1

    entities = list(parse_entities(text))
    cps, areas = [], []
    for pairs in entities:
        classname = get(pairs, 'classname')
        if classname == 'dod_control_point':
            cps.append(pairs)
        elif classname == 'dod_capture_area':
            areas.append(pairs)

    print('  %d entities, %d dod_control_point, %d dod_capture_area\n'
          % (len(entities), len(cps), len(areas)))

    if not cps:
        print('  No dod_control_point entities - not an objective map.\n')
        return 0

    header = ('  %-4s %-26s %-18s %-20s %-11s %-15s %s'
              % ('lump', 'point_name', 'targetname', 'origin',
                 'point_index', 'default_owner', 'team_points'))
    print(header)
    print('  ' + '-' * (len(header) - 2))

    usable = 0
    seen_index = {}
    duplicates = set()
    for i, pairs in enumerate(cps):
        idx, shown = as_point_index(get(pairs, 'point_index'))
        if idx >= 0:
            usable += 1
            if idx in seen_index:
                duplicates.add(idx)
            seen_index.setdefault(idx, []).append(i)
        owner_raw = get(pairs, 'point_default_owner', '0')
        owner = '%s (%s)' % (owner_raw, OWNER_NAMES.get(owner_raw, '?'))
        print('  %-4d %-26s %-18s %-20s %-11s %-15s %s'
              % (i,
                 get(pairs, NAME_KEY, '-')[:26],
                 get(pairs, 'targetname', '-')[:18],
                 get(pairs, 'origin', '-')[:20],
                 shown,
                 owner,
                 get(pairs, 'point_team_points', '-')))

    if areas:
        print('\n  Capture areas (the multi-man / timed caps):')
        cp_targetnames = {get(p, 'targetname') for p in cps if get(p, 'targetname')}
        for pairs in areas:
            linked = [v for k, v in pairs
                      if v in cp_targetnames and k not in ('classname', 'targetname')]
            detail = ' '.join(
                '%s=%s' % (k, v) for k, v in pairs
                if k.startswith('area_') or k in ('target', 'origin'))
            print('    -> CP %-18s %s'
                  % (linked[0] if linked else '(unresolved)', detail))

    geo = geometric_order(cps)

    # Verdict — mirrors the branches in DODX_InitCPFromEntities.
    print('\n  dodx verdict:')
    healthy = usable == len(cps) and not duplicates
    if healthy:
        order = sorted(range(len(cps)),
                       key=lambda i: as_point_index(get(cps[i], 'point_index'))[0])
        print('    OK - %d/%d CPs carry a usable point_index; the reorder will run.'
              % (usable, len(cps)))
        print('    Resulting CP order (ascending point_index):')
        for slot, i in enumerate(order):
            print('      cp_index %d  <-  lump #%d  %s'
                  % (slot, i, label_of(cps[i])))
    elif usable == 0:
        print('    BROKEN - no CP carries a usable point_index (absent or -1).')
        print('    dodx logs "BSP parse returned 0 CPs" and keeps entity-spawn')
        print('    order, so every CP name is attached to the wrong flag.')
    elif duplicates:
        print('    BROKEN - point_index values repeat: %s.'
              % ', '.join(str(d) for d in sorted(duplicates)))
        print('    The sort is ascending-by-value only, so ties are not ordered.')
    else:
        print('    BROKEN - only %d of %d CPs carry a usable point_index.'
              % (usable, len(cps)))
        print('    dodx logs "BSP CP count != entity scan count" and skips the')
        print('    reorder entirely. Every CP needs the key, not just most.')

    if geo is None:
        print('\n  Geometry: indeterminate (bad origins, or no allied/axis '
              'default owner to orient by).')
        print()
        return 0

    geo_order, geo_axis, ascending, ambiguous = geo
    if healthy:
        # Self-check: on a map that already ships correct values, does the
        # geometric heuristic reproduce them? Validates the heuristic before it
        # is trusted on a map that doesn't.
        verdict = ('MATCHES' if geo_order == order
                   else 'DIFFERS — heuristic is not reliable on this layout')
        print('\n  Geometry cross-check (%s axis, %s): %s'
              % (geo_axis, 'ascending' if ascending else 'descending', verdict))
        if geo_order != order:
            print('    shipped:   %s' % ' -> '.join(label_of(cps[i]) for i in order))
            print('    geometric: %s' % ' -> '.join(label_of(cps[i]) for i in geo_order))
    else:
        print('\n  Suggested point_index (allies->axis along the %s axis, %s):'
              % (geo_axis, 'ascending' if ascending else 'descending'))
        print('    %-6s %-28s %s' % ('lump', 'point_name', 'set point_index to'))
        for i in range(len(cps)):
            print('    %-6d %-28s %d'
                  % (i, label_of(cps[i])[:28], geo_order.index(i) + 1))
        print('    Resulting order: %s'
              % ' | '.join(label_of(cps[i]) for i in geo_order))
        if ambiguous:
            print('\n    !! Geometry CANNOT settle these adjacent pairs - they sit')
            print('       at similar depth but are offset sideways, which is the')
            print('       exact case that defeats this projection:')
            for a, b in ambiguous:
                print('         %s  <->  %s'
                      % (label_of(cps[a])[:30], label_of(cps[b])[:30]))
        print('\n    VERIFY against the map\'s in-game HUD (left to right) before')
        print('    shipping - the HUD is drawn in DLL cp_index order, and it is')
        print('    the only ground truth that settles the pairs above.')
    print()
    return 0


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    rc = 0
    for path in sys.argv[1:]:
        rc |= dump(path)
    return rc


if __name__ == '__main__':
    sys.exit(main())
