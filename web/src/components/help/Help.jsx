import React from 'react';
import { Container, Row, Col } from 'react-bootstrap';

import './Help.css';

const shot = (name) => `${process.env.PUBLIC_URL || ''}/help/${name}`;

function Section({ id, title, children }) {
    return (
        <section id={id} className="help-section">
            <h2>{title}</h2>
            {children}
        </section>
    );
}

function Screenshot({ name, alt }) {
    return <img className="help-screenshot" src={shot(name)} alt={alt} />;
}

class Help extends React.Component {
    render() {
        return (
            <Container className="help-container">
                <Row>
                    <Col>
                        <h1>Viewer Guide</h1>
                        <p className="help-lead">
                            How to get the DoD HUD Observer overlay into OBS, and what the panels
                            on it mean.
                        </p>

                        <nav className="help-toc">
                            <strong>On this page:</strong>
                            <ul>
                                <li><a href="#obs-setup">OBS Setup</a></li>
                                <li><a href="#features">Features</a></li>
                                <li><a href="#future">Future Features</a></li>
                                <li><a href="#troubleshooting">Troubleshooting</a></li>
                            </ul>
                        </nav>

                        <Section id="obs-setup" title="OBS Setup">
                            <p>
                                The overlay runs as a <strong>Browser Source</strong> in OBS,
                                layered over your HLTV capture.
                            </p>
                            <blockquote className="help-callout">
                                <strong>This overlay is designed to sit on top of a live HLTV view
                                of the match</strong> — it does not provide the game footage itself.
                                Your OBS scene should already have a capture source (Window Capture,
                                Game Capture, or Display Capture) pointed at an HLTV client
                                connected to the same match. The Browser Source described below is
                                added <strong>above</strong> that capture source so the HUD renders
                                over the live feed.
                            </blockquote>

                            <h3>1. Get the overlay URL for the server</h3>
                            <ol>
                                <li>Open the HUD Observer home page in a browser (e.g.{' '}
                                    <code>http://74.91.112.242:3000/</code>).</li>
                                <li>Click the <a href="/watch"><strong>Watch / Replay</strong></a> link.</li>
                                <li>Under <strong>Game Servers</strong>, find the server whose match you're casting.</li>
                                <li>
                                    <strong>Right-click the "Watch" (or "Watch Live") link</strong>{' '}
                                    in the Actions column and choose <strong>Copy link address</strong>.
                                </li>
                            </ol>
                            <p>That gives you a URL like:</p>
                            <pre className="help-url">http://74.91.112.242:3000/screen?server=KTP%20-%20Denver%205</pre>

                            <h3>2. Add a Browser source in OBS</h3>
                            <p>
                                In OBS, right-click the <strong>Sources</strong> panel →
                                <strong> Add</strong> → <strong>Browser</strong> (or click the
                                <strong> +</strong> under Sources).
                            </p>
                            <Screenshot name="obs-add-browser-source.png" alt="Adding a Browser source in OBS" />

                            <h3>3. Paste the URL and configure the source</h3>
                            <p>In the Browser source properties:</p>
                            <ul>
                                <li><strong>URL</strong> — paste the URL you copied from <code>/watch</code>.</li>
                                <li><strong>Width</strong> — <code>1920</code></li>
                                <li><strong>Height</strong> — <code>1080</code></li>
                                <li>Leave <strong>Custom CSS</strong> at default; the overlay is already transparent.</li>
                                <li>
                                    Tick <strong>Refresh browser when scene becomes active</strong> —
                                    ensures a clean re-sync between matches.
                                </li>
                            </ul>
                            <Screenshot name="obs-browser-source-url.png" alt="Browser source URL configuration" />
                            <p>
                                Make sure this Browser source sits <strong>above</strong> your HLTV
                                capture source in the OBS scene list so the HUD renders on top.
                            </p>
                        </Section>

                        <Section id="features" title="Features">
                            <Screenshot name="hud-overview.png" alt="HUD overview" />

                            <h3>Flag Bar (top-left)</h3>
                            <p>Live territorial capture points, left-to-right in objective order.</p>
                            <ul>
                                <li><strong className="team-allies">Green</strong> — held by Allies</li>
                                <li><strong className="team-axis">Red</strong> — held by Axis</li>
                                <li><strong>Dark / neutral</strong> — uncaptured</li>
                                <li><strong>"capping"</strong> label with player names — the other team is actively on the point</li>
                            </ul>
                            <p>
                                Below the flag bar, a small <strong>flag feed</strong> shows recent
                                captures and <strong>CAP BREAK</strong> events (defender stopped an
                                in-progress cap).
                            </p>

                            <h3>Score and Timer (top-center)</h3>
                            <ul>
                                <li>Team labels — <strong className="team-allies">ALLIES</strong> and <strong className="team-axis">AXIS</strong>, fixed for the match</li>
                                <li>Flag-capture score for the current half (resets 0–0 at halftime)</li>
                                <li>Match timer — <code>mm:ss</code> remaining, server-synced every 30s so it can't drift</li>
                            </ul>

                            <h3>Kill Feed (top-right)</h3>
                            <p>Scrolling kill notifications.</p>
                            <ul>
                                <li>Killer (left) and victim (right), colored by team</li>
                                <li>Weapon icon in the middle (<code>garand</code>, <code>mp40</code>, <code>bar</code>, <code>mg42</code>, …)</li>
                                <li><strong>Headshot</strong> icon (yellow-glow helmet) next to the weapon when the kill was a headshot</li>
                                <li>
                                    <strong>Kill-streak badge</strong> — a yellow <code>3K</code> / <code>4K</code> / … tag
                                    appears in front of the killer's name once they've chained three or more kills
                                    without dying. Resets on death or round start.
                                </li>
                                <li><strong>PRONE</strong> tag on the victim side when the kill landed on a prone/deployed player</li>
                                <li>Suicides and team-kills styled distinctly</li>
                            </ul>

                            <h3>Player Cards (bottom)</h3>
                            <p>Six cards per team along the bottom — Allies left, Axis right.</p>
                            <ul>
                                <li>Large <strong>HP</strong> number (greys out on death, refills on respawn)</li>
                                <li><strong>Skull icon</strong> when dead</li>
                                <li><strong>Name</strong> and current-class <strong>primary weapon</strong></li>
                                <li><strong>Kills / Deaths</strong> for the current half (green / red)</li>
                            </ul>
                            <p>Cards update instantly on spawn, death, class change, and kill.</p>

                            <h3>Prone Shame Timer</h3>
                            <p>
                                DoD is a movement game; camping prone is frowned on in competitive
                                play. The overlay calls it out:
                            </p>
                            <ul>
                                <li>A red <strong>PRONE</strong> timer appears on the player's card the moment they go prone or deploy</li>
                                <li>It ticks up in seconds from a server-provided timestamp (drift-proof)</li>
                                <li>It clears on stand-up, respawn, or death</li>
                                <li>Kill-feed entries also carry a <strong>PRONE</strong> tag if the victim died while prone</li>
                            </ul>

                            <h3>Halftime and Match End</h3>
                            <p>At halftime (<code>half_start</code>, half 2):</p>
                            <ul>
                                <li>Scores reset to 0–0</li>
                                <li>Per-player kill/death counters reset</li>
                                <li>Flag bar resets to starting ownership</li>
                                <li>The roster persists — same players, swapped sides</li>
                            </ul>
                            <p>
                                At match end the HUD freezes on the final state until the next
                                match starts or the browser source is refreshed.
                            </p>
                        </Section>

                        <Section id="future" title="Future Features">
                            <p>Not yet built — tracked for a later release:</p>
                            <ul>
                                <li>
                                    <strong>Match replay</strong> — play back a completed match
                                    from its recorded <code>events.jsonl</code>. The
                                    <code> ?replay=true</code> query parameter is reserved for this
                                    and currently has no effect.
                                </li>
                                <li>
                                    <strong>HLTV sync via HLAE</strong> — align the overlay's event
                                    timeline with a demo playing in HLTV / Half-Life Advanced
                                    Effects, so the HUD matches a rewatched demo frame-for-frame.
                                </li>
                                <li>
                                    <strong>Observed-player card</strong> — a bottom-center card
                                    showing whichever player the caster is currently spectating.
                                    The HUD plugin can't yet tell which player the HLTV client has
                                    focused on, so this is shelved until we have a signal to drive
                                    it.
                                </li>
                            </ul>
                        </Section>

                        <Section id="troubleshooting" title="Troubleshooting">
                            <ul>
                                <li><strong>Blank overlay</strong> — confirm the backend is reachable on <code>:4000</code> (Socket.IO) and <code>:3001</code> (REST). Check the browser dev console for connection errors.</li>
                                <li><strong>Wrong server showing</strong> — the <code>?server=</code> value must match the server's registered hostname exactly, including case and spaces (URL-encoded). Visit <a href="/watch"><code>/watch</code></a> to get the correct copy-paste URL.</li>
                                <li><strong>Timer drifting</strong> — the server sends a <code>time_sync</code> every 30s; if the displayed timer is more than a few seconds off, the Socket.IO connection may be dropping.</li>
                                <li><strong>Players missing from roster</strong> — player cards populate on <code>player_spawn</code>. New connections who haven't spawned yet won't appear until their first spawn.</li>
                                <li><strong>Wrong flag order / names</strong> — <code>flags_init</code> fires once per map load. Reload the map to resend.</li>
                            </ul>
                            <p>
                                For the full event schema and architecture details, see the{' '}
                                <a href="https://github.com/JimmyLockhart65616/DoD-hud-observer/blob/master/CLAUDE.md">
                                    CLAUDE.md
                                </a>{' '}
                                and{' '}
                                <a href="https://github.com/JimmyLockhart65616/DoD-hud-observer/blob/master/docs/VIEWER_GUIDE.md">
                                    VIEWER_GUIDE.md
                                </a>{' '}
                                on GitHub.
                            </p>
                        </Section>
                    </Col>
                </Row>
            </Container>
        );
    }
}

export default Help;
