/**
 * Contract tests for the career-stats hook.
 *
 * The thing worth pinning is not the happy path — it is the LOAD PROTECTION
 * behaviour, because every failure mode here is silent on a caster's monitor:
 *
 *  - a 503 must latch OFF permanently, so a page left open on an instance with
 *    no stats database does not poll it forever;
 *  - one request must cover the whole roster, never one per player;
 *  - a transient failure must keep the last good data rather than blanking.
 *
 * jsdom, no network: `fetch` is stubbed per test.
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react';

import { useCareerStats } from './useCareerStats';

// Minimal probe component — renders the hook's output as text so assertions can
// read status and row count without reaching into React internals.
const Probe = ({ ids }) => {
    const { careers, status } = useCareerStats(ids);
    return (
        <div>
            <span data-testid="status">{status}</span>
            <span data-testid="count">{Object.keys(careers).length}</span>
        </div>
    );
};

const jsonResponse = (body, status = 200) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
});

const CAREER = {
    players: {
        'STEAM_0:0:1001': { steam_id: 'STEAM_0:0:1001', matches: 4, kills: 40, deaths: 30, headshots: 7 },
        'STEAM_0:0:2001': { steam_id: 'STEAM_0:0:2001', matches: 2, kills: 20, deaths: 25, headshots: 3 },
    },
};

// Lets a pending fetch promise settle and React flush the resulting state.
const flush = async () => { await act(async () => { await Promise.resolve(); }); };

describe('useCareerStats', () => {
    afterEach(() => { delete global.fetch; jest.restoreAllMocks(); });

    it('asks for the whole roster in ONE request, with sorted ids', async () => {
        global.fetch = jest.fn(() => jsonResponse(CAREER));

        render(<Probe ids={['STEAM_0:0:2001', 'STEAM_0:0:1001']} />);
        await flush();

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const url = decodeURIComponent(global.fetch.mock.calls[0][0]);
        // Sorted, so two clients with the same roster in different connect
        // orders share the backend's cache entry instead of each paying a query.
        expect(url).toContain('ids=STEAM_0:0:1001,STEAM_0:0:2001');
        expect(screen.getByTestId('status').textContent).toBe('ready');
        expect(screen.getByTestId('count').textContent).toBe('2');
    });

    it('de-duplicates repeated ids', async () => {
        global.fetch = jest.fn(() => jsonResponse({ players: {} }));

        render(<Probe ids={['STEAM_0:0:1001', 'STEAM_0:0:1001', 'STEAM_0:0:1001']} />);
        await flush();

        const url = decodeURIComponent(global.fetch.mock.calls[0][0]);
        expect(url).toContain('ids=STEAM_0:0:1001');
        expect(url).not.toContain('1001,STEAM_0:0:1001');
    });

    // 503 covers BOTH "stats database not configured" (the production default
    // today) and "guard is shedding load". Retrying either would add load to a
    // server that has just said it cannot take any.
    it('latches off permanently on a 503 and stops polling', async () => {
        global.fetch = jest.fn(() => jsonResponse({ error: 'not configured' }, 503));

        const { rerender } = render(<Probe ids={['STEAM_0:0:1001']} />);
        await flush();

        expect(screen.getByTestId('status').textContent).toBe('unavailable');
        expect(global.fetch).toHaveBeenCalledTimes(1);

        // A roster change would normally re-run the effect and fetch again.
        rerender(<Probe ids={['STEAM_0:0:1001', 'STEAM_0:0:2001']} />);
        await flush();
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('reports an error rather than blanking when the first request fails', async () => {
        global.fetch = jest.fn(() => Promise.reject(new Error('network down')));

        render(<Probe ids={['STEAM_0:0:1001']} />);
        await flush();

        expect(screen.getByTestId('status').textContent).toBe('error');
        expect(screen.getByTestId('count').textContent).toBe('0');
    });

    it('never fetches for an empty roster', async () => {
        global.fetch = jest.fn(() => jsonResponse(CAREER));

        render(<Probe ids={[]} />);
        await flush();

        expect(global.fetch).not.toHaveBeenCalled();
        expect(screen.getByTestId('status').textContent).toBe('loading');
    });

    it('tolerates a response with no players key', async () => {
        global.fetch = jest.fn(() => jsonResponse({}));

        render(<Probe ids={['STEAM_0:0:1001']} />);
        await flush();

        expect(screen.getByTestId('status').textContent).toBe('ready');
        expect(screen.getByTestId('count').textContent).toBe('0');
    });
});
