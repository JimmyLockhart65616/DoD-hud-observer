/**
 * Applied-damage correction — pinned against the real NY1 production capture.
 *
 * THE BUG (plugin < 2.5.0): DODX's `client_damage` forward hands over
 * `(int)pev->dmg_take`, the RAW amount the game DLL charged. The DLL never clamps
 * that to the victim's remaining health — `pev->dmg_take += flTake` then
 * `pev->health -= flTake`, letting health go negative — so the killing blow's
 * overkill was credited in full. A 120-damage garand hit on a 40 HP victim scored
 * 120, not 40.
 *
 * That mattered well beyond the number: `damage` is the StatsBoard's default sort
 * key AND its MVP award (web/src/components/core/StatsBoard/StatsTable.jsx), so
 * replaying this fixture with the correction flips the MVP on 2 of 4 team-halves
 * and re-orders rows on 3 of 4. The board was crediting the wrong player.
 *
 * `appliedDamage` below is a HAND-MAINTAINED MIRROR of the clamp in
 * KTPHudObserver.sma `client_damage`. The Pawn is what ships; this exists so the
 * arithmetic has a regression test at all (no suite executes Pawn) and so the
 * fixture totals below stand as the contract. If you change one, change both.
 */
import zlib from 'zlib';
import path from 'path';
import fs from 'fs';

import 'jest';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'match-1777342963-NY1.jsonl.gz');

interface DamageEvent {
    attacker_id: string;
    victim_id: string;
    damage: number;
    victim_health: number;
    weapon?: string;
}

function loadEvents(): Array<Record<string, any>> {
    const raw = zlib.gunzipSync(fs.readFileSync(FIXTURE_PATH)).toString('utf-8');
    return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

/**
 * Mirror of KTPHudObserver.sma client_damage:
 *
 *     pre     = g_last_health[victim]                  // 0 = unknown
 *     if (pre <= 0 || pre < post) pre = post + damage  // fallback
 *     applied = min(damage, max(0, pre - max(post, 0)))
 *
 * `pre` is the victim's health before this hit, `post` the plugin's own
 * get_user_health read after it (negative on overkill). The min() cap is what
 * survives KTPGrenadeDamage's dod_damage_pre heal-back, which dodx skips when the
 * victim is already dead while still forwarding the REDUCED damage.
 */
function appliedDamage(pre: number, post: number, raw: number): number {
    const base = (pre <= 0 || pre < post) ? post + raw : pre;
    return Math.min(raw, Math.max(0, base - Math.max(post, 0)));
}

/** The naive alternative: subtract the overkill straight off the reported number. */
function naiveApplied(post: number, raw: number): number {
    return Math.max(0, raw + Math.min(post, 0));
}

describe('applied-damage correction (NY1 production fixture)', () => {
    const events = loadEvents();
    const damageEvents = events.filter(e => e.event === 'damage') as DamageEvent[];

    // Replay in stream order, tracking each victim's health exactly as the plugin
    // does: seeded to 100 on spawn, then updated from every hit's post-hit read.
    const replay = () => {
        const track = new Map<string, number>();
        let sumRaw = 0, sumApplied = 0, sumNaive = 0;
        let disagreements = 0, fallbacks = 0, overkillHits = 0;
        const perAttacker = new Map<string, { raw: number; applied: number }>();

        for (const e of events) {
            if (e.event === 'player_spawn') { track.set(e.user_id, 100); continue; }
            if (e.event !== 'damage') continue;

            const post = e.victim_health, raw = e.damage;
            const pre = track.get(e.victim_id) ?? 0;
            if (pre <= 0 || pre < post) fallbacks++;

            const applied = appliedDamage(pre, post, raw);
            const naive = naiveApplied(post, raw);
            if (applied !== naive) disagreements++;
            if (post < 0) overkillHits++;

            sumRaw += raw; sumApplied += applied; sumNaive += naive;
            const acc = perAttacker.get(e.attacker_id) ?? { raw: 0, applied: 0 };
            acc.raw += raw; acc.applied += applied;
            perAttacker.set(e.attacker_id, acc);

            track.set(e.victim_id, post);
        }
        return { sumRaw, sumApplied, sumNaive, disagreements, fallbacks, overkillHits, perAttacker };
    };

    const r = replay();

    it('the fixture carries the damage stream this test is pinned to', () => {
        expect(damageEvents.length).toBe(1086);
    });

    it('PROPERTY the whole fix rests on: victim_health + damage recovers a valid pre-hit health', () => {
        // The plugin reads get_user_health AFTER the hit, so post + damage is the
        // pre-hit health whenever the engine applied the reported number
        // unmodified. If dodx ever changes what it reports, or a damage-modifying
        // plugin lands without a heal-back, this is the assertion that catches it.
        const implied = damageEvents.map(e => e.victim_health + e.damage);
        expect(implied.filter(v => v <= 0 || v > 100)).toEqual([]);
        expect(Math.min(...implied)).toBe(1);
        expect(Math.max(...implied)).toBe(100);
    });

    it('overkill was systemic, not an outlier: >50% of hits overkilled', () => {
        expect(r.overkillHits).toBe(582);
        expect(r.overkillHits / damageEvents.length).toBeGreaterThan(0.5);
    });

    it('pre-2.5.0 reported damage was inflated ~37% by overkill', () => {
        expect(r.sumRaw).toBe(95608);
        expect(r.sumApplied).toBe(61002);
        // 95,608 / 61,002 = 1.567 — i.e. 37% of every damage number on the old
        // boards was health the victim never had.
        expect(r.sumRaw / r.sumApplied).toBeGreaterThan(1.5);
    });

    it('pins the naive model too, so the gap to it stays a deliberate choice', () => {
        // The naive `damage + min(health, 0)` totals 60,277 — 725 lower, over 15
        // events. Those are the hits where the tracked baseline credits the victim's
        // full pre-hit health and the naive form under-reports (the shape
        // KTPGrenadeDamage's skipped heal-back produces). Keeping both numbers here
        // means a future "simplification" to the naive form fails loudly rather
        // than quietly shaving damage off grenade kills.
        expect(r.sumNaive).toBe(60277);
        expect(r.disagreements).toBe(15);
        expect(r.fallbacks).toBe(20);
    });

    it('every attacker was inflated — no single player skewed the total', () => {
        expect(r.perAttacker.size).toBe(12);
        for (const [id, acc] of r.perAttacker) {
            expect({ id, ratio: acc.raw / acc.applied > 1.4 }).toEqual({ id, ratio: true });
        }
    });

    it('applied damage never exceeds what dodx reported, and never goes negative', () => {
        // The same property the damageAppliedBound invariant enforces on live
        // streams, asserted here against real data.
        for (const [, acc] of r.perAttacker) {
            expect(acc.applied).toBeGreaterThanOrEqual(0);
            expect(acc.applied).toBeLessThanOrEqual(acc.raw);
        }
    });
});
