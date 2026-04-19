import React from 'react';

import { SocketStoreComponent, useHudStore } from '../core/Socket/Socket';
import Replay from '../core/Replay/Replay';
import Crosshair from '../core/Crosshair/Crosshair';
import Kill from '../core/Kill/Kill';
import Score from '../core/Score/Score';
import PlayersLeft from '../core/PlayersLeft/PlayersLeft';
import PlayersRight from '../core/PlayersRight/PlayersRight';
import Flags from '../core/Flags/Flags';
import FlagFeed from '../core/FlagFeed/FlagFeed';
// PlayerObserved disabled: no HLTV signal yet to know which player the caster is watching.
// import PlayerObserved from '../core/PlayerObserved/PlayerObserved';

import hudconfig from './hud.json';

import './Screen.css';

function Example() {

    const team1Name = 'ALLIES';
    const team2Name = 'AXIS';
    const logoLeft = 'default.png';
    const logoRight = 'default.png';

    const urlParams = new URLSearchParams(window.location.search);
    const matchId = urlParams.get('match');
    const isReplay = urlParams.get('replay') === 'true';

    const alliesPlayers = useHudStore(s => s.allies_players);
    const axisPlayers   = useHudStore(s => s.axis_players);
    const kills         = useHudStore(s => s.kills);
    const alliesScore   = useHudStore(s => s.allies_score);
    const axisScore     = useHudStore(s => s.axis_score);
    const roundState    = useHudStore(s => s.round_state);
    const flags         = useHudStore(s => s.flags);
    const flagFeed      = useHudStore(s => s.flag_feed);
    const timeleft      = useHudStore(s => s.timeleft);
    const timeleftAt    = useHudStore(s => s.timeleft_at);

    return (
        <div className="grid-container">

            <SocketStoreComponent />

            {isReplay && matchId && <Replay matchId={matchId} />}

            <Crosshair />

            <div className="flags-bar">
                <Flags flags={flags} />
            </div>

            <div className="flagfeed-container">
                <FlagFeed entries={flagFeed} screentime={hudconfig.settings.kill_displaytime} />
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

            {/* <div className="observed-bar">
                <PlayerObserved players={[...alliesPlayers, ...axisPlayers]} />
            </div> */}

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
