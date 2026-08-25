/**
 * When the career panel is allowed to be on screen at all.
 *
 * Every hidden case here exists for the same reason: a caster's second monitor
 * showing a panel that says nothing reads as a broken lookup, not as an honest
 * empty result. The distinction the panel DOES need to make is between a player
 * with no league record and a player who scored nothing — those are different
 * stories — so the "no league record" row must survive as long as at least one
 * player on the roster has real data.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

import CareerPanel from './CareerPanel';
import { useCareerStats } from './useCareerStats';

jest.mock('./useCareerStats');

const ALLIES = [
    { user_id: 'STEAM_0:0:1001', name: 'Raphinha', team: 'allies' },
    { user_id: 'STEAM_0:0:1002', name: 'bud', team: 'allies' },
];
const AXIS = [{ user_id: 'STEAM_0:0:2001', name: 'mogers', team: 'axis' }];

const CAREER = {
    'STEAM_0:0:1001': {
        steam_id: 'STEAM_0:0:1001', matches: 12, kills: 400, deaths: 300, headshots: 60,
    },
};

const renderPanel = (allies = ALLIES, axis = AXIS) =>
    render(<CareerPanel alliesPlayers={allies} axisPlayers={axis} />);

afterEach(() => jest.resetAllMocks());

describe('CareerPanel visibility', () => {
    it('renders when at least one player has a record', () => {
        useCareerStats.mockReturnValue({ careers: CAREER, status: 'ready' });
        renderPanel();

        expect(screen.getByText('League Career')).toBeInTheDocument();
        expect(screen.getByText('1.33')).toBeInTheDocument();   // 400/300
        expect(screen.getByText('15%')).toBeInTheDocument();    // 60/400
    });

    // A debutant next to players who DO have history is exactly the case the
    // row exists for, so it must not be swept away by the empty-roster rule.
    it('still marks individual players with no record', () => {
        useCareerStats.mockReturnValue({ careers: CAREER, status: 'ready' });
        renderPanel();

        expect(screen.getAllByText('no league record')).toHaveLength(2);
    });

    // The live production state today: match_type is NULL on every row, so the
    // official-play filter matches nothing and every career is empty.
    it('hides entirely when NOBODY has a record', () => {
        useCareerStats.mockReturnValue({ careers: {}, status: 'ready' });
        const { container } = renderPanel();

        expect(container.querySelector('.caster-panel-career')).toBeNull();
    });

    // 'unavailable' covers both "no database configured" and "shedding load".
    it('hides when the stats database is unavailable', () => {
        useCareerStats.mockReturnValue({ careers: {}, status: 'unavailable' });
        const { container } = renderPanel();

        expect(container.querySelector('.caster-panel-career')).toBeNull();
    });

    it('hides before any player has connected', () => {
        useCareerStats.mockReturnValue({ careers: {}, status: 'ready' });
        const { container } = renderPanel([], []);

        expect(container.querySelector('.caster-panel-career')).toBeNull();
    });

    // Gated on 'ready' so a slow first request does not flash the panel out and
    // back in while the roster is still filling.
    it('does not hide on an empty result that is still loading', () => {
        useCareerStats.mockReturnValue({ careers: {}, status: 'loading' });
        const { container } = renderPanel();

        expect(container.querySelector('.caster-panel-career')).not.toBeNull();
    });
});
