/**
 * /api/servers projection — fleet ordering and HLTV pairing.
 *
 * Both properties are invisible in the response shape and easy to regress:
 * the ordering only misbehaves once a region reaches ten servers, and a
 * mis-paired HLTV address sends a viewer to a port nothing is listening on
 * rather than failing loudly.
 */
import { MetricsCollector } from '../handler/metrics';
import {
    buildServerList,
    compareServerHostnames,
    type HltvConnectConfig,
} from '../handler/serverList';

import 'jest';

const FLEET: HltvConnectConfig = {
    host: '203.0.113.7',
    ports: {
        'KTP - Atlanta 1': 27020,
        'KTP - Chicago 1': 27040,
        'KTP - Denver 5': 27034,
        'KTP - New York 1': 27035,
    },
};

function metricsFor(hostnames: string[]): MetricsCollector {
    const metrics = new MetricsCollector();
    for (const h of hostnames) metrics.recordEvent(h);
    return metrics;
}

const noPlayers = () => 0;

describe('compareServerHostnames', () => {
    it('orders by region then by number, not lexicographically', () => {
        const shuffled = [
            'KTP - New York 2',
            'KTP - Atlanta 1',
            'KTP - Denver 5',
            'KTP - Chicago 1',
            'KTP - Atlanta 5',
            'KTP - New York 1',
        ];
        expect([...shuffled].sort(compareServerHostnames)).toEqual([
            'KTP - Atlanta 1',
            'KTP - Atlanta 5',
            'KTP - Chicago 1',
            'KTP - Denver 5',
            'KTP - New York 1',
            'KTP - New York 2',
        ]);
    });

    it('puts 10 after 9 — the whole reason this is not localeCompare', () => {
        const sorted = ['KTP - Denver 10', 'KTP - Denver 2', 'KTP - Denver 9']
            .sort(compareServerHostnames);
        expect(sorted).toEqual(['KTP - Denver 2', 'KTP - Denver 9', 'KTP - Denver 10']);
    });

    it('is a total order — never reports equality for strings that differ', () => {
        // localeCompare alone returns 0 for pairs the collator considers
        // equivalent, which would make the sort order depend on input order.
        expect(compareServerHostnames('KTP - Atlanta 1', 'KTP - Atlanta 1')).toBe(0);
        expect(compareServerHostnames('a', 'a\u0000')).not.toBe(0);
    });
});

describe('buildServerList', () => {
    it('returns rows in fleet order regardless of which server POSTed first', () => {
        const metrics = metricsFor([
            'KTP - New York 1',
            'KTP - Atlanta 1',
            'KTP - Chicago 1',
            'KTP - Denver 5',
        ]);
        const rows = buildServerList(metrics, FLEET, noPlayers);
        expect(rows.map(r => r.hostname)).toEqual([
            'KTP - Atlanta 1',
            'KTP - Chicago 1',
            'KTP - Denver 5',
            'KTP - New York 1',
        ]);
    });

    it('pairs each server with its own proxy port on the shared public host', () => {
        const rows = buildServerList(metricsFor(['KTP - Denver 5', 'KTP - Atlanta 1']), FLEET, noPlayers);
        expect(rows.find(r => r.hostname === 'KTP - Denver 5')!.hltv)
            .toEqual({ host: '203.0.113.7', port: 27034 });
        expect(rows.find(r => r.hostname === 'KTP - Atlanta 1')!.hltv)
            .toEqual({ host: '203.0.113.7', port: 27020 });
    });

    it('leaves hltv null for a server with no configured proxy', () => {
        // Hand-run LAN boxes report to ingest but have no proxy on the data
        // server — offering them a connect link would be a dead address.
        const rows = buildServerList(metricsFor(['KTP LAN 3']), FLEET, noPlayers);
        expect(rows[0].hltv).toBeNull();
    });

    it('offers no links at all when no public host is configured', () => {
        // A dev laptop: the ports would be right but the host is not reachable,
        // so the whole feature stays dark rather than half-working.
        const rows = buildServerList(
            metricsFor(['KTP - Atlanta 1']),
            { host: '', ports: FLEET.ports },
            noPlayers,
        );
        expect(rows[0].hltv).toBeNull();
    });

    it('keeps the existing row fields and never leaks last_seen', () => {
        const metrics = metricsFor(['KTP - Atlanta 1']);
        metrics.recordEvent('KTP - Atlanta 1');
        const rows = buildServerList(metrics, FLEET, (h) => (h === 'KTP - Atlanta 1' ? 12 : 0));
        expect(rows[0]).toEqual({
            hostname: 'KTP - Atlanta 1',
            total_events: 2,
            online: true,
            players: 12,
            hltv: { host: '203.0.113.7', port: 27020 },
        });
    });
});
