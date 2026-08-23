#!/usr/bin/env python3
"""Is CAP_BREAK_RADIUS big enough to cover a real DoD capture zone?

KTPHudObserver only queues a cap-break candidate when the victim died within
CAP_BREAK_RADIUS horizontal units of the control point they were capturing. If a
map's capture BRUSH reaches further from the CP origin than that, a genuine
on-point death is rejected and the break is silently lost.

The capture zone is a brush entity (`dod_capture_area` with model "*N"), and
GoldSrc lump 14 (MODELS) carries every brush model's mins/maxs. So the worst-case
in-zone distance is computable straight from the BSP: the furthest horizontal
corner of the brush from its CP's origin.

Also reports CP-to-CP spacing: two points closer than 2*R have overlapping
radii, which the plugin resolves by taking the CLOSEST point.

    python3 cap-radius-check.py <radius> <map.bsp> [<map.bsp> ...]
"""
import math
import os
import struct
import sys

HEADER_LUMPS = 15
LUMP_ENTITIES = 0
LUMP_MODELS = 14


def read_lump(path, index):
    with open(path, 'rb') as fh:
        header = fh.read(4 + HEADER_LUMPS * 8)
        if len(header) < 4 + HEADER_LUMPS * 8:
            raise ValueError('short header')
        version = struct.unpack_from('<i', header, 0)[0]
        if version != 30:
            raise ValueError('bsp version %d, expected 30' % version)
        offset, length = struct.unpack_from('<ii', header, 4 + index * 8)
        fh.seek(offset)
        return fh.read(length)


def parse_entities(text):
    ents, cur, in_block = [], None, False
    for raw in text.splitlines():
        line = raw.strip()
        if line == '{':
            cur, in_block = [], True
        elif line == '}':
            if in_block and cur is not None:
                ents.append(cur)
            cur, in_block = None, False
        elif in_block and line.startswith('"'):
            parts = line.split('"')
            if len(parts) >= 5:
                cur.append((parts[1], parts[3]))
    return ents


def get(pairs, key, default=''):
    for k, v in pairs:
        if k == key:
            return v
    return default


def parse_models(blob):
    # GoldSrc dmodel_t: mins[3] maxs[3] origin[3] headnode[4] visleafs firstface numfaces
    SIZE = 3 * 4 + 3 * 4 + 3 * 4 + 4 * 4 + 4 + 4 + 4
    out = []
    for i in range(len(blob) // SIZE):
        vals = struct.unpack_from('<9f', blob, i * SIZE)
        out.append((vals[0:3], vals[3:6]))
    return out


def analyse(path, radius):
    name = os.path.basename(path).replace('.bsp', '')
    ents = parse_entities(read_lump(path, LUMP_ENTITIES).decode('latin-1', 'replace'))
    models = parse_models(read_lump(path, LUMP_MODELS))

    cps = {}
    for e in ents:
        if get(e, 'classname') == 'dod_control_point':
            tn = get(e, 'targetname')
            try:
                o = [float(x) for x in get(e, 'origin', '0 0 0').split()]
            except ValueError:
                o = [0.0, 0.0, 0.0]
            cps[tn] = o

    worst = []
    for e in ents:
        if get(e, 'classname') != 'dod_capture_area':
            continue
        target = get(e, 'target')
        mdl = get(e, 'model')
        if target not in cps or not mdl.startswith('*'):
            continue
        try:
            mi, ma = models[int(mdl[1:])]
        except (ValueError, IndexError):
            continue
        cx, cy = cps[target][0], cps[target][1]
        # furthest horizontal corner of the brush from the CP origin
        d = max(math.hypot(x - cx, y - cy)
                for x in (mi[0], ma[0]) for y in (mi[1], ma[1]))
        worst.append((target, d))

    dists = []
    keys = list(cps)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            a, b = cps[keys[i]], cps[keys[j]]
            dists.append(math.hypot(a[0] - b[0], a[1] - b[1]))

    return name, len(cps), worst, (min(dists) if dists else None)


def main():
    radius = float(sys.argv[1])
    rows = []
    for p in sys.argv[2:]:
        try:
            rows.append(analyse(p, radius))
        except Exception as exc:
            print('  !! %-24s %s' % (os.path.basename(p), exc))

    print('radius = %.0f units\n' % radius)
    print('%-22s %3s  %-34s %s' % ('map', 'CPs', 'furthest in-zone corner from CP', 'min CP-CP'))
    print('-' * 92)
    exceed, overlap = [], []
    for name, ncp, worst, mind in sorted(rows):
        if worst:
            tgt, d = max(worst, key=lambda t: t[1])
            flag = '  <-- EXCEEDS' if d > radius else ''
            w = '%7.0f  (%s)%s' % (d, tgt[:18], flag)
            if d > radius:
                exceed.append((name, d, tgt))
        else:
            w = '      -  (no brush-modelled area)'
        m = '%7.0f' % mind if mind is not None else '      -'
        if mind is not None and mind < 2 * radius:
            overlap.append((name, mind))
        print('%-22s %3d  %-34s %s' % (name, ncp, w, m))

    print('\nzones reaching past the radius (breaks would be LOST): %d of %d' % (len(exceed), len(rows)))
    for n, d, t in sorted(exceed, key=lambda r: -r[1]):
        print('   %-22s %6.0f  %s' % (n, d, t))
    print('\nmaps where two CPs are closer than 2*radius (overlapping, closest-wins): %d' % len(overlap))
    for n, d in sorted(overlap, key=lambda r: r[1]):
        print('   %-22s %6.0f' % (n, d))


if __name__ == '__main__':
    main()
