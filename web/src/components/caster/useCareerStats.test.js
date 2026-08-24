/**
 * Contract tests for the career-stats hook.
 *
 * The thing worth pinning is not the happy path — it is the LOAD PROTECTION
 * behaviour, because every failure mode here is silent on a caster's monitor:
 *
 *  - a filling roster must cost ONE request, not one per player. Firing twelve
 *    in a burst trips the backend's concurrency cap and gets them shed, at
 *    exactly the moment the panel first has something to show. This was a real
 *    bug, caught against the local stack (8 shed requests on one mocker run).
 *  - `reason: 'disabled'` must latch OFF permanently, so a page left open on an
 *    instance with no stats database does not poll it forever;
 *  - `reason: 'shedding'` must NOT latch — the guard recovers on its own, and
 *    standing down for good because the server was briefly busy defeats it.
 *    Both are 503, so only the body tells them apart.
 *  - a transient failure must keep the last good data rather than blanking.
 *
 * jsdom, no network: `fetch` is stubbed per test. Fake timers throughout,
 * because the hook waits SETTLE_MS before its first request.
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react';

import { useCareerStats } from './useCareerStats';

const SETTLE_MS = 750;

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

/** Advance past the settle delay and let the fetch promise chain flush. */
const settle = async () => {
    await act(async () => { jest.advanceTimersByTime(SETTLE_MS); });
    await act(async () => { await Promise.resolve(); });
};

describe('useCareerStats', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => {
        jest.useRealTimers();
        delete global.fetch;
        jest.restoreAllMocks();
    });

    it('asks for the whole roster in ONE request, with sorted ids', async () => {
        global.fetch = jest.fn(() => jsonResponse(CAREER));

        render(<Probe ids={['STEAM_0:0:2001', 'STEAM_0:0:1001']} />);
        await settle();

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const url = decodeURIComponent(global.fetch.mock.calls[0][0]);
        // Sorted, so two clients with the same roster in different connect
        // orders share the backend's cache entry instead of each paying a query.
        expect(url).toContain('ids=STEAM_0:0:1001,STEAM_0:0:2001');
        expect(screen.getByTestId('status').textContent).toBe('ready');
        expect(screen.getByTestId('count').textContent).toBe('2');
    });

    // The roster arrives one player at a time. Each arrival changes the id set
    // and re-runs the effect; without the settle delay that is one request per
    // player, in a burst, which is what the backend's concurrency cap sheds.
    it('coalesces a roster that fills in one player at a time', async () => {
        global.fetch = jest.fn(() => jsonResponse(CAREER));

        const { rerender } = render(<Probe ids={['STEAM_0:0:1001']} />);
        for (const extra of ['2001', '1002', '2002', '1003']) {
            act(() => { jest.advanceTimersByTime(100); });
            rerender(<Probe ids={['STEAM_0:0:1001', `STEAM_0:0:${extra}`]} />);
        }
        await settle();

        expect(global.fetch).toHaveBeenCalledTimes(1);
        // And it asked for the FINAL roster, not the first snapshot.
        expect(decodeURIComponent(global.fetch.mock.calls[0][0])).toContain('STEAM_0:0:1003');
    });

    it('de-duplicates repeated ids', async () => {
        global.fetch = jest.fn(() => jsonResponse({ players: {} }));

        render(<Probe ids={['STEAM_0:0:1001', 'STEAM_0:0:1001', 'STEAM_0:0:1001']} />);
        await settle();

        const url = decodeURIComponent(global.fetch.mock.calls[0][0]);
        expect(url).toContain('ids=STEAM_0:0:1001');
        expect(url).not.toContain('1001,STEAM_0:0:1001');
    });

    // "Not configured" is the production default today. Retrying it forever
    // would be pure noise against a server that will never answer.
    it('latches off permanently on a disabled 503', async () => {
        global.fetch = jest.fn(() => jsonResponse({ reason: 'disabled' }, 503));

        const { rerender } = render(<Probe ids={['STEAM_0:0:1001']} />);
        await settle();

        expect(screen.getByTestId('status').textContent).toBe('unavailable');
        expect(global.fetch).toHaveBeenCalledTimes(1);

        // A roster change would normally re-run the effect and fetch again.
        rerender(<Probe ids={['STEAM_0:0:1001', 'STEAM_0:0:2001']} />);
        await settle();
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    // A shed is the guard working, and it clears by itself. Standing down for
    // the rest of the broadcast because the data server was briefly busy is
    // exactly the behaviour the breaker exists to avoid.
    it('does NOT latch off on a shedding 503, and retries', async () => {
        global.fetch = jest.fn()
            .mockImplementationOnce(() => jsonResponse({ reason: 'shedding' }, 503))
            .mockImplementationOnce(() => jsonResponse(CAREER));

        render(<Probe ids={['STEAM_0:0:1001']} />);
        await settle();

        expect(screen.getByTestId('status').textContent).toBe('error');

        // Back-off elapses -> it tries again and recovers.
        await act(async () => { jest.advanceTimersByTime(120_000); });
        await act(async () => { await Promise.resolve(); });

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(screen.getByTestId('status').textContent).toBe('ready');
    });

    // An older backend sends no `reason`. Permanent is the safe reading: an
    // instance with genuinely no database should not be polled forever.
    it('treats a 503 with no reason as permanent', async () => {
        global.fetch = jest.fn(() => jsonResponse({ error: 'nope' }, 503));

        render(<Probe ids={['STEAM_0:0:1001']} />);
        await settle();

        expect(screen.getByTestId('status').textContent).toBe('unavailable');
    });

    it('reports an error rather than blanking when the first request fails', async () => {
        global.fetch = jest.fn(() => Promise.reject(new Error('network down')));

        render(<Probe ids={['STEAM_0:0:1001']} />);
        await settle();

        expect(screen.getByTestId('status').textContent).toBe('error');
        expect(screen.getByTestId('count').textContent).toBe('0');
    });

    it('keeps the last good data across a later failure', async () => {
        global.fetch = jest.fn()
            .mockImplementationOnce(() => jsonResponse(CAREER))
            .mockImplementationOnce(() => Promise.reject(new Error('network down')));

        render(<Probe ids={['STEAM_0:0:1001']} />);
        await settle();
        expect(screen.getByTestId('count').textContent).toBe('2');

        await act(async () => { jest.advanceTimersByTime(300_000); });
        await act(async () => { await Promise.resolve(); });

        // Still 'ready' on the cached rows — a dropped poll must not blank a
        // reference monitor mid-broadcast.
        expect(screen.getByTestId('status').textContent).toBe('ready');
        expect(screen.getByTestId('count').textContent).toBe('2');
    });

    it('never fetches for an empty roster', async () => {
        global.fetch = jest.fn(() => jsonResponse(CAREER));

        render(<Probe ids={[]} />);
        await settle();

        expect(global.fetch).not.toHaveBeenCalled();
        expect(screen.getByTestId('status').textContent).toBe('loading');
    });

    it('tolerates a response with no players key', async () => {
        global.fetch = jest.fn(() => jsonResponse({}));

        render(<Probe ids={['STEAM_0:0:1001']} />);
        await settle();

        expect(screen.getByTestId('status').textContent).toBe('ready');
        expect(screen.getByTestId('count').textContent).toBe('0');
    });
});
