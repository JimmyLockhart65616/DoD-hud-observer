import React from 'react';

import { SocketStoreComponent, useHudStore } from '../core/Socket/Socket';
import Replay from '../core/Replay/Replay';
import Kill from '../core/Kill/Kill';
import Score from '../core/Score/Score';
import PlayersLeft from '../core/PlayersLeft/PlayersLeft';
import PlayersRight from '../core/PlayersRight/PlayersRight';
import Flags from '../core/Flags/Flags';
import FlagFeed from '../core/FlagFeed/FlagFeed';
import StatsBoard from '../core/StatsBoard/StatsBoard';
import WavePill from '../core/Score/wave/WavePill';
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

    const alliesAlive = alliesPlayers.filter(p => !p.dead).length;
    const axisAlive   = axisPlayers.filter(p => !p.dead).length;
    const kills         = useHudStore(s => s.kills);
    const alliesScore   = useHudStore(s => s.allies_score);
    const axisScore     = useHudStore(s => s.axis_score);
    const roundState    = useHudStore(s => s.round_state);
    const flags         = useHudStore(s => s.flags);
    const flagFeed      = useHudStore(s => s.flag_feed);
    const timeleft      = useHudStore(s => s.timeleft);
    const timeleftAt    = useHudStore(s => s.timeleft_at);
    const statsBoard    = useHudStore(s => s.stats_board);

    const waveAllies        = useHudStore(s => s.wave_allies);
    const waveAlliesAt      = useHudStore(s => s.wave_allies_at);
    const waveAlliesPending = useHudStore(s => s.wave_allies_pending);
    const waveAxis          = useHudStore(s => s.wave_axis);
    const waveAxisAt        = useHudStore(s => s.wave_axis_at);
    const waveAxisPending   = useHudStore(s => s.wave_axis_pending);

    const clockFrozen = roundState.round_freeze || roundState.round_end;

    return (
        <div className="grid-container">

            <SocketStoreComponent />

            {isReplay && matchId && <Replay matchId={matchId} />}

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
                <span className="team-name team-name-allies">
                    {team1Name}
                    <span className="team-alive team-alive-allies" title="Players alive">{alliesAlive}</span>
                </span>
                <Score
                    roundState={roundState}
                    alliesScore={alliesScore}
                    axisScore={axisScore}
                    logoLeft={logoLeft}
                    logoRight={logoRight}
                    timeleft={timeleft}
                    timeleftAt={timeleftAt}
                />
                <span className="team-name team-name-axis">
                    <span className="team-alive team-alive-axis" title="Players alive">{axisAlive}</span>
                    {team2Name}
                </span>
            </div>

            <div className="hud-middle">
                <StatsBoard board={statsBoard} settings={hudconfig.settings} />
            </div>

            {/* <div className="observed-bar">
                <PlayerObserved players={[...alliesPlayers, ...axisPlayers]} />
            </div> */}

            {/* Reinforcement-wave pills sit directly above each team's card strip,
                next to the dead cards they explain. Deliberately NOT in the top bar:
                .flags-bar is an absolute overlay across that same 72px band, so at
                the ~1280 prod OBS canvas the allies side is already buried behind the
                flag strip (see e2e/snapshots/fixed-1280x720.png — ALLIES itself is
                hidden there). The bottom band has width to spare at every size. */}
            <div className="bottom-bar">
                <div className="team-column">
                    <div className="team-wave-row team-wave-row-allies">
                        <WavePill
                            seconds={waveAllies}
                            secondsAt={waveAlliesAt}
                            pending={waveAlliesPending}
                            side="allies"
                            frozen={clockFrozen}
                        />
                    </div>
                    <div className="team-cards">
                        <PlayersLeft players={alliesPlayers} />
                    </div>
                </div>
                <div className="bottom-center-gap" />
                <div className="team-column">
                    <div className="team-wave-row team-wave-row-axis">
                        <WavePill
                            seconds={waveAxis}
                            secondsAt={waveAxisAt}
                            pending={waveAxisPending}
                            side="axis"
                            frozen={clockFrozen}
                        />
                    </div>
                    <div className="team-cards">
                        <PlayersRight players={axisPlayers} />
                    </div>
                </div>
            </div>

        </div>
    );
}

export default Example;
