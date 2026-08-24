import React, { useMemo } from 'react';

import { useHudStore } from '../core/Socket/Socket';

/*
 * Minimap — /caster
 *
 * SCHEMATIC, not a map render. There is no background image and that is a
 * deliberate consequence of what the assets actually are: GoldSrc ships
 * `overviews/<map>.bmp` + `.txt` (a mapper-authored world->image transform), but
 * only for STOCK maps. Of the 15 maps played on the league in the last 120 days,
 * exactly TWO have one — dod_anzio and dod_donner. The pool runs custom and
 * versioned builds (dod_saints2_b3e, dod_railyard_s9d, dod_anjou_a5, ...) and
 * those ship nothing. An overview-backed minimap would therefore be dark on 13
 * of 15 maps.
 *
 * So the frame comes from the flags themselves: control points bound the played
 * area on every map, need no per-map asset, and cannot go stale when the pool
 * changes. What is lost is terrain — this shows RELATIVE positions against the
 * objectives, not walls or elevation.
 *
 * On /caster only, not /screen. It is new and expected to be rough, and the
 * on-air overlay is not the place to find that out. Promote it when a caster
 * asks, the way the other panels were.
 *
 * 2D by design: dodx exposes no CP_origin_z, so there is no height data for the
 * flags to scale against even if players carried it.
 */

// Fraction of the flag bounding box added as margin, so players who push past
// the outermost objective (spawns, flanks) still land on the panel instead of
// being clamped onto its edge.
const PAD = 0.35;

// Below this the bounding box is a degenerate line — one flag, or several
// stacked on the same coordinate because dodx never populated them. Rendering
// that produces a divide-by-zero smear rather than a map.
const MIN_EXTENT = 64;

const VIEW_W = 320;
const VIEW_H = 320;

/**
 * World -> panel transform, derived from the flag bounding box.
 *
 * Returns null when there is nothing usable to frame, which the caller renders
 * as an explicit "no map data" rather than an empty box — on a reference monitor
 * those look identical and mean very different things.
 *
 * Y IS FLIPPED. GoldSrc world Y increases north; SVG Y increases downward, so
 * plotting raw would mirror the map top-to-bottom — the kind of bug that looks
 * plausible until someone calls a push the wrong way on air.
 */
export function buildTransform(flags) {
    const pts = (flags || [])
        .filter(f => typeof f.x === 'number' && typeof f.y === 'number')
        // Exact (0,0) is the plugin saying dodx never populated this CP, not a
        // point at the world centre. Including it would stretch the box across
        // half the world and squash every real flag into a corner.
        .filter(f => !(f.x === 0 && f.y === 0));

    if (pts.length < 2) return null;

    const xs = pts.map(p => p.x);
    const ys = pts.map(p => p.y);
    let minX = Math.min(...xs), maxX = Math.max(...xs);
    let minY = Math.min(...ys), maxY = Math.max(...ys);

    let w = maxX - minX;
    let h = maxY - minY;
    if (w < MIN_EXTENT && h < MIN_EXTENT) return null;

    // Pad, then square the box so the transform is UNIFORM on both axes. A
    // non-uniform fit would stretch a long map to fill the panel and quietly
    // misrepresent every distance on it.
    const padX = Math.max(w * PAD, MIN_EXTENT);
    const padY = Math.max(h * PAD, MIN_EXTENT);
    minX -= padX; maxX += padX;
    minY -= padY; maxY += padY;
    w = maxX - minX;
    h = maxY - minY;

    const size = Math.max(w, h);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    return {
        toPanel(x, y) {
            return {
                px: ((x - (cx - size / 2)) / size) * VIEW_W,
                py: VIEW_H - ((y - (cy - size / 2)) / size) * VIEW_H,
            };
        },
    };
}

const OWNER_FILL = { allies: '#8fbf4a', axis: '#c0504a', neutral: '#6b7192' };

const Minimap = () => {
    const flags = useHudStore(s => s.flags);
    const alliesPlayers = useHudStore(s => s.allies_players);
    const axisPlayers = useHudStore(s => s.axis_players);

    const transform = useMemo(() => buildTransform(flags), [flags]);

    if (!transform) {
        return (
            <section className="caster-panel caster-panel-minimap">
                <h2>Minimap</h2>
                <p className="caster-idle">
                    No flag coordinates yet — needs plugin 2.8.0 and a live map.
                </p>
            </section>
        );
    }

    const markers = [];
    for (const [team, list] of [['allies', alliesPlayers], ['axis', axisPlayers]]) {
        for (const p of list) {
            if (!p.pos) continue;              // unreadable origin, see the store
            if (p.dead) continue;              // a corpse is not a position
            const { px, py } = transform.toPanel(p.pos.x, p.pos.y);
            markers.push({ id: p.user_id, name: p.name, team, px, py });
        }
    }

    return (
        <section className="caster-panel caster-panel-minimap">
            <h2>Minimap <span className="caster-count">{markers.length} live</span></h2>
            <svg
                className="caster-minimap"
                viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
                role="img"
                aria-label="Schematic minimap of flag and player positions"
            >
                {flags
                    .filter(f => typeof f.x === 'number' && !(f.x === 0 && f.y === 0))
                    .map(f => {
                        const { px, py } = transform.toPanel(f.x, f.y);
                        return (
                            <g key={f.flag_id}>
                                <rect
                                    x={px - 5} y={py - 5} width={10} height={10}
                                    transform={`rotate(45 ${px} ${py})`}
                                    fill={OWNER_FILL[f.owner] || OWNER_FILL.neutral}
                                    stroke="#11131f"
                                    strokeWidth="1.5"
                                />
                                <text x={px} y={py - 10} className="caster-minimap-flag">
                                    {f.flag_name}
                                </text>
                            </g>
                        );
                    })}

                {markers.map(m => (
                    <circle
                        key={m.id}
                        cx={m.px} cy={m.py} r={4}
                        className={`caster-minimap-dot caster-minimap-${m.team}`}
                    >
                        <title>{m.name}</title>
                    </circle>
                ))}
            </svg>
        </section>
    );
};

export default Minimap;
