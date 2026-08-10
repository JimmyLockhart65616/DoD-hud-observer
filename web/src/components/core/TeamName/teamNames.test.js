import { teamName, setTeamName, swapTeamNames, isPinned, DEFAULT_NAMES, MAX_LEN } from './teamNames';

// The caster-typed team-name override. Pins the resolution order (URL > stored >
// default) and the two gestures that have to survive a live match: clearing a
// name back to the default, and swapping the pair at halftime.

const setSearch = (search) => {
    delete window.location;
    window.location = { search };
};

beforeEach(() => {
    window.localStorage.clear();
    setSearch('');
});

describe('resolution order', () => {
    it('falls back to the side default with nothing set', () => {
        expect(teamName('allies')).toBe('ALLIES');
        expect(teamName('axis')).toBe('AXIS');
    });

    it('returns a stored name once one is set', () => {
        setTeamName('allies', 'Black Sheep');
        expect(teamName('allies')).toBe('Black Sheep');
        expect(teamName('axis')).toBe('AXIS');
    });

    it('lets a URL param outrank storage, and marks that side pinned', () => {
        setTeamName('allies', 'Black Sheep');
        setSearch('?allies=URL%20TEAM');

        expect(teamName('allies')).toBe('URL TEAM');
        expect(isPinned('allies')).toBe(true);
        // The other side is untouched and still editable.
        expect(isPinned('axis')).toBe(false);
        expect(teamName('axis')).toBe('AXIS');
    });

    it('survives localStorage holding junk', () => {
        window.localStorage.setItem('hud.team_names', 'not json');
        expect(teamName('allies')).toBe(DEFAULT_NAMES.allies);
    });
});

describe('editing', () => {
    it('normalises whitespace and caps length', () => {
        setTeamName('axis', '  Das   Reich \n');
        expect(teamName('axis')).toBe('Das Reich');

        setTeamName('axis', 'x'.repeat(MAX_LEN + 20));
        expect(teamName('axis')).toHaveLength(MAX_LEN);
    });

    it('clears back to the default on an empty value', () => {
        setTeamName('allies', 'Black Sheep');
        setTeamName('allies', '   ');
        expect(teamName('allies')).toBe('ALLIES');
        // Nothing left behind that a later swap could resurrect.
        expect(window.localStorage.getItem('hud.team_names')).toBe(null);
    });
});

describe('halftime swap', () => {
    it('exchanges both names', () => {
        setTeamName('allies', 'Black Sheep');
        setTeamName('axis', 'Das Reich');
        swapTeamNames();

        expect(teamName('allies')).toBe('Das Reich');
        expect(teamName('axis')).toBe('Black Sheep');
    });

    it('moves a lone name across without writing the default onto the other side', () => {
        setTeamName('allies', 'Black Sheep');
        swapTeamNames();

        expect(teamName('axis')).toBe('Black Sheep');
        expect(teamName('allies')).toBe('ALLIES');

        // ...and back again — a swap must be its own inverse, or a caster who
        // swaps at the wrong whistle can't undo it.
        swapTeamNames();
        expect(teamName('allies')).toBe('Black Sheep');
        expect(teamName('axis')).toBe('AXIS');
    });
});
