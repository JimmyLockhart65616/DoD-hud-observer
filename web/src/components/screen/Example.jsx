import React, { useEffect, useState } from 'react';

import { SocketStoreComponent, useHudStore } from '../core/Socket/Socket';
import Crosshair from '../core/Crosshair/Crosshair';
import Kill from '../core/Kill/Kill';
import Score from '../core/Score/Score';
import PlayersLeft from '../core/PlayersLeft/PlayersLeft';
import PlayersRight from '../core/PlayersRight/PlayersRight';
import Flags from '../core/Flags/Flags';
import PlayerObserved from '../core/PlayerObserved/PlayerObserved';

import * as api from './api/api';
import hudconfig from './hud.json';

import './Screen.css';

function Example() {

    const [team1Name,  setTeam1Name]  = useState('ALLIES');
    const [team2Name,  setTeam2Name]  = useState('AXIS');
    const [logoLeft,   setLogoLeft]   = useState('default.png');
    const [logoRight,  setLogoRight]  = useState('default.png');

    // Load team branding from match ID in URL (?match=<id>)
    useEffect(() => {
        const urlParams = new URLSearchParams(window.location.search);
        const matchId = urlParams.get('match');
        if (!matchId) return;

        api.matches.getMatch(matchId)
            .then(res => {
                const { team_one, team_two } = res.match_info;
                return Promise.all([
                    api.teams.getTeam(team_one),
                    api.teams.getTeam(team_two),
                ]);
            })
            .then(([t1, t2]) => {
                setTeam1Name(t1.team_info.team_short_name.toUpperCase());
                setLogoLeft(t1.team_info.team_logo_name);
                setTeam2Name(t2.team_info.team_short_name.toUpperCase());
                setLogoRight(t2.team_info.team_logo_name);
            })
            .catch(err => console.error('[Example] Failed to load match info:', err));
    }, []);

    const alliesPlayers = useHudStore(s => s.allies_players);
    const axisPlayers   = useHudStore(s => s.axis_players);
    const kills         = useHudStore(s => s.kills);
    const alliesScore   = useHudStore(s => s.allies_score);
    const axisScore     = useHudStore(s => s.axis_score);
    const roundState    = useHudStore(s => s.round_state);
    const flags         = useHudStore(s => s.flags);
    const timeleft      = useHudStore(s => s.timeleft);
    const timeleftAt    = useHudStore(s => s.timeleft_at);

    return (
        <div className="grid-container">

            <SocketStoreComponent />

            <Crosshair />

            <div className="flags-bar">
                <Flags flags={flags} />
            </div>

            <div className="box-right">
                <Kill screentime={hudconfig.settings.kill_displaytime} kills={kills} />
            </div>

            <div className="top-bar">
                <span className="team-name team-name-allies">{team1Name}</span>
                <Score
                    roundState={roundState}
                    alliesScore={alliesScore}
                    axisScore={axisScore}
                    logoLeft={logoLeft}
                    logoRight={logoRight}
                    timeleft={timeleft}
                    timeleftAt={timeleftAt}
                />
                <span className="team-name team-name-axis">{team2Name}</span>
            </div>

            <div className="hud-middle" />

            <div className="observed-bar">
                <PlayerObserved players={[...alliesPlayers, ...axisPlayers]} />
            </div>

            <div className="bottom-bar">
                <div className="team-cards">
                    <PlayersLeft players={alliesPlayers} />
                </div>
                <div className="bottom-center-gap" />
                <div className="team-cards">
                    <PlayersRight players={axisPlayers} />
                </div>
            </div>

        </div>
    );
}

export default Example;
