import React from 'react';
import { Container, Row, Col } from 'react-bootstrap';

class Welcome extends React.Component {
    render() {
        return (
            <Container style={{ marginTop: '40px' }}>
                <Row>
                    <Col>
                        <p>
                            Day of Defeat 1.3 live broadcast overlay for OBS.
                        </p>
                        <ul style={{ marginTop: '16px', lineHeight: '2' }}>
                            <li><a href="/watch">Watch / Replay</a> — pick a live or completed match</li>
                            <li><a href="/help">Viewer Guide</a> — how to set up and use the HUD in OBS</li>
                        </ul>
                        <h5 style={{ marginTop: '32px' }}>
                            What's New <small className="text-muted" style={{ fontSize: '0.7em', fontWeight: 'normal' }}>2026-08-17</small>
                        </h5>
                        <ul style={{ marginTop: '8px', lineHeight: '1.8' }}>
                            <li>
                                Match status — the top bar now says which part of the match you're watching, in small
                                type above the clock: <strong>WARM-UP</strong> while the teams ready up,
                                <strong> GOING LIVE</strong> during the countdown, then <strong>1ST HALF</strong> or
                                <strong> 2ND HALF</strong>, <strong>HALFTIME</strong> while they swap sides,
                                <strong> OVERTIME 1</strong>, and <strong>FINAL</strong> once it's over. Joining a
                                stream mid-match no longer means guessing
                            </li>
                            <li>
                                The clock now stops at halftime, between overtime rounds, and after the final whistle.
                                It used to keep counting down through all three, so a halftime scoreboard sat under a
                                clock that looked like play was still running
                            </li>
                            <li>
                                Nothing is shown during ordinary public play — the status only appears when a real
                                match is on
                            </li>
                        </ul>
                        <h5 style={{ marginTop: '32px' }}>
                            What's New <small className="text-muted" style={{ fontSize: '0.7em', fontWeight: 'normal' }}>2026-08-11</small>
                        </h5>
                        <ul style={{ marginTop: '8px', lineHeight: '1.8' }}>
                            <li>
                                Scoring timer — DoD quietly awards each team points for the flags it holds, on a
                                repeating timer the game itself never shows you anywhere. The top bar now counts down
                                to the next award (<strong>NEXT SCORE</strong>, under the match clock), and each team's
                                score shows what it's about to gain, e.g. <code>+4</code>. You only score for ground
                                you've taken — sitting on your own starting flags pays nothing, which is why a team
                                can show <code>+0</code>
                            </li>
                            <li>
                                The award figures only appear once the numbers have been checked against the live
                                scoreboard, so on an unusual map you may see the countdown with no <code>+N</code> beside
                                the scores. The timer itself is always accurate
                            </li>
                            <li>
                                Maps where the award is rare (some run it as little as once every 15 minutes) hide the
                                timer entirely rather than show a countdown nobody is playing to
                            </li>
                            <li>
                                Damage numbers corrected — the <strong>DMG</strong> column was counting the whole hit
                                even when it was more than the player had left, so a 120-damage rifle shot on someone
                                with 40 health scored 120 instead of 40. It now counts damage actually done. Figures
                                are around a third lower across the board, and the damage ranking and MVP highlight on
                                the stats board are now the real ones
                            </li>
                        </ul>
                        <h5 style={{ marginTop: '32px' }}>
                            What's New <small className="text-muted" style={{ fontSize: '0.7em', fontWeight: 'normal' }}>2026-08-09</small>
                        </h5>
                        <ul style={{ marginTop: '8px', lineHeight: '1.8' }}>
                            <li>
                                Custom team names — double-click either team name in the top bar and type it in
                                (in OBS: right-click the source → Interact). It's remembered on that machine until
                                you change it, so it's a one-time thing per event; ⇄ swaps the two names at
                                halftime. The stats board picks the names up too. You can also set them from the
                                source URL instead: <code>/screen?allies=BLACK+SHEEP&amp;axis=DAS+REICH</code>
                            </li>
                            <li>Respawn timer — each team's card strip now shows the seconds until that side's next reinforcement wave</li>
                            <li>
                                Flag ownership fixes — flags now start the map owned by the right side on maps with
                                default-owned flags (donner, kalt, flash, saints2), and the bar resets correctly
                                after a round restart or a capout instead of going grey and staying grey
                            </li>
                            <li>Removed the per-team alive counter from the top bar — the player cards already show who's down</li>
                        </ul>
                        <h5 style={{ marginTop: '32px' }}>
                            What's New <small className="text-muted" style={{ fontSize: '0.7em', fontWeight: 'normal' }}>2026-06-25</small>
                        </h5>
                        <ul style={{ marginTop: '8px', lineHeight: '1.8' }}>
                            <li>Flag captures now name the players who made the cap — in the cap feed and in the capout board title</li>
                            <li>New cap break stat: kill an enemy while they're standing on a flag mid-capture and you're credited with a cap break (new BRK column on the stats board), with a live callout in the flag feed</li>
                        </ul>
                        <h5 style={{ marginTop: '32px' }}>
                            What's New <small className="text-muted" style={{ fontSize: '0.7em', fontWeight: 'normal' }}>2026-06-13</small>
                        </h5>
                        <ul style={{ marginTop: '8px', lineHeight: '1.8' }}>
                            <li>Stats board on every full capout, at halftime, and at match end — cumulative per-player kills/deaths/assists, damage, headshot %, flag caps, grenade kills, and best kill streak, with team totals and an MVP highlight</li>
                            <li>The capout board is titled by who swept the last flag (e.g. "ALLIES CAPOUT BY mogers")</li>
                            <li>Assists tracked (50+ damage to a victim someone else finishes) and shown inline in the kill feed</li>
                            <li>Teamkill count surfaced in the kill feed (e.g. "TK ×2")</li>
                        </ul>
                        <h5 style={{ marginTop: '32px' }}>
                            What's New <small className="text-muted" style={{ fontSize: '0.7em', fontWeight: 'normal' }}>2026-06-10</small>
                        </h5>
                        <ul style={{ marginTop: '8px', lineHeight: '1.8' }}>
                            <li>Player cards now show each player's live equipped weapon (updates as they switch)</li>
                            <li>Grenade count on every player card</li>
                            <li>Floating damage numbers pop up when a player takes a hit</li>
                            <li>Per-team alive counter in the top bar</li>
                            <li>Cleaner card layout — health bar on top, icon-labeled kills/deaths</li>
                        </ul>
                        <h5 style={{ marginTop: '32px' }}>
                            What's New <small className="text-muted" style={{ fontSize: '0.7em', fontWeight: 'normal' }}>2026-06-08</small>
                        </h5>
                        <ul style={{ marginTop: '8px', lineHeight: '1.8' }}>
                            <li>Weapon icons now show in the kill feed and on player cards</li>
                        </ul>
                        <h5 style={{ marginTop: '32px' }}>
                            What's New <small className="text-muted" style={{ fontSize: '0.7em', fontWeight: 'normal' }}>2026-05-02</small>
                        </h5>
                        <ul style={{ marginTop: '8px', lineHeight: '1.8' }}>
                            <li>Flag colors no longer flip to neutral on round restart</li>
                            <li>Fewer dropped events when the backend is under load (plugin event timeout raised 1s → 3s)</li>
                        </ul>
                        <h5 style={{ marginTop: '32px' }}>
                            What's New <small className="text-muted" style={{ fontSize: '0.7em', fontWeight: 'normal' }}>2026-04-27</small>
                        </h5>
                        <ul style={{ marginTop: '8px', lineHeight: '1.8' }}>
                            <li>HLTV time sync enabled (incl. half-boundary event flush)</li>
                            <li>Team scores now read from gamerules — scoreboard correct</li>
                            <li>Flag cap spam on round restart fixed</li>
                            <li>Flag feed limited to 3 entries</li>
                            <li>Kill feed limited to 6 entries</li>
                            <li>Feed items hide correctly when OBS tab is backgrounded</li>
                            <li>HUD survives map change between halves</li>
                        </ul>
                    </Col>
                </Row>
            </Container>
        );
    }
}

export default Welcome;