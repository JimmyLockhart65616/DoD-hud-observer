import React, { useEffect, useState } from 'react';
import { Container, Row, Col, Table, Badge } from 'react-bootstrap';

// Origin-relative: unset REACT_APP_API_URL (single-origin proxy deployments) ⇒
// same-origin relative fetches (`/api/...`), so one build works at localhost or
// hud.ktpdod.com. Dev workflows set REACT_APP_API_URL explicitly.
const API_URL = process.env.REACT_APP_API_URL || '';

// `hltv` comes from the backend's hltv_connect config (see serverList.ts) and is
// null for any server with no proxy — hand-run LAN boxes, or a fleet member added
// to the picker before it was added to the config.
const hltvAddress = (hltv) => `${hltv.host}:${hltv.port}`;

// Steam's own protocol handler: it queries the address, works out that it's a
// GoldSrc DoD server, launches the game and connects. Preferred over
// steam://rungameid/30 because it needs no app id baked in here, and it does the
// right thing whether or not the game is already running.
const hltvConnectUrl = (hltv) => `steam://connect/${hltvAddress(hltv)}`;

function MatchPicker() {
    const [servers, setServers] = useState([]);
    const [liveMatches, setLiveMatches] = useState([]);
    const [storedMatches, setStoredMatches] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;

        const refreshLive = () => Promise.all([
            fetch(`${API_URL}/api/servers`).then(r => r.json()),
            fetch(`${API_URL}/api/matches/live`).then(r => r.json()),
        ])
            .then(([serverData, live]) => {
                if (cancelled) return live;
                setServers(serverData.servers || []);
                setLiveMatches(live.matches || []);
                return live;
            });

        // Initial load fetches stored matches too; polling refreshes only the
        // live side (servers + active matches) since /stored is expensive and
        // changes slowly.
        Promise.all([
            refreshLive(),
            fetch(`${API_URL}/api/matches/stored`).then(r => r.json()),
        ])
            .then(([live, stored]) => {
                if (cancelled) return;
                const liveIds = new Set((live.active || []).map(String));
                setStoredMatches(
                    (stored.matches || []).filter(m => !liveIds.has(m.matchId))
                );
                setLoading(false);
            })
            .catch(err => {
                if (cancelled) return;
                console.error('[MatchPicker] fetch error:', err);
                setError(err.message);
                setLoading(false);
            });

        const interval = setInterval(() => {
            refreshLive().catch(err => console.error('[MatchPicker] poll error:', err));
        }, 5000);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, []);

    if (loading) return <Container style={{ marginTop: 40 }}><p>Loading...</p></Container>;
    if (error) return <Container style={{ marginTop: 40 }}><p>Error: {error}</p></Container>;

    const formatDate = (iso) => {
        if (!iso) return '\u2014';
        return new Date(iso).toLocaleString();
    };

    const activeMatchesByServer = new Map();
    for (const m of liveMatches) {
        if (m.endedAt) continue;
        const prev = activeMatchesByServer.get(m.sourceServer);
        if (!prev || new Date(m.startedAt) > new Date(prev.startedAt)) {
            activeMatchesByServer.set(m.sourceServer, m);
        }
    }

    const completed = [...liveMatches.filter(m => m.endedAt), ...storedMatches]
        .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

    return (
        <Container style={{ marginTop: 40 }}>
            <Row>
                <Col>
                    <h2>Server &amp; Match Picker</h2>

                    <h4 style={{ marginTop: 24 }}>
                        Game Servers <Badge bg="info">{servers.length}</Badge>
                    </h4>
                    {servers.length === 0 ? (
                        <p className="text-muted">No servers have sent events yet. Start a game server with the HUD plugin.</p>
                    ) : (
                        <Table striped bordered hover size="sm">
                            <thead>
                                <tr>
                                    <th>Server</th>
                                    <th>Server Status</th>
                                    <th>Current Match</th>
                                    <th>Players</th>
                                    <th>HLTV</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {servers.map(s => {
                                    const match = activeMatchesByServer.get(s.hostname);
                                    return (
                                        <tr key={s.hostname}>
                                            <td><code>{s.hostname}</code></td>
                                            <td>
                                                <Badge bg={s.online ? 'success' : 'secondary'}>
                                                    {s.online ? 'Online' : 'Offline'}
                                                </Badge>
                                            </td>
                                            <td>
                                                {match ? (
                                                    <>
                                                        <Badge bg="success" style={{ marginRight: 8 }}>Live</Badge>
                                                        <code>{match.matchId}</code>
                                                        {match.map ? <> &middot; {match.map}</> : null}
                                                    </>
                                                ) : (
                                                    <span className="text-muted">Not live</span>
                                                )}
                                            </td>
                                            <td>
                                                {s.players > 0 ? (
                                                    s.players
                                                ) : (
                                                    <span className="text-muted">0</span>
                                                )}
                                            </td>
                                            <td>
                                                {s.hltv ? (
                                                    <a
                                                        href={hltvConnectUrl(s.hltv)}
                                                        style={{ fontFamily: 'var(--bs-font-monospace, monospace)' }}
                                                        title={`Opens Day of Defeat through Steam and joins this server's HLTV broadcast. Console equivalent: connect ${hltvAddress(s.hltv)}`}
                                                    >
                                                        {hltvAddress(s.hltv)}
                                                    </a>
                                                ) : (
                                                    <span className="text-muted" title="No HLTV proxy is configured for this server">&mdash;</span>
                                                )}
                                            </td>
                                            <td>
                                                <a href={`/screen?server=${encodeURIComponent(s.hostname)}`}>
                                                    {match ? 'Watch Live' : 'Watch'}
                                                </a>
                                                {' | '}
                                                <a
                                                    href={`/caster?server=${encodeURIComponent(s.hostname)}`}
                                                    title="Persistent stats page for casters (broadcast-synced, second monitor)"
                                                >
                                                    Caster View
                                                </a>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </Table>
                    )}

                    <p className="text-muted" style={{ fontSize: '0.9em', marginTop: 4 }}>
                        An <strong>HLTV</strong> address opens Day of Defeat through Steam and joins that
                        server's broadcast proxy as a spectator. The proxy runs on the same 60-second delay
                        the overlay is synced to, so what you see there matches what a stream is showing
                        rather than running ahead of it. If your browser won't hand off{' '}
                        <code>steam://</code> links, paste <code>connect &lt;address&gt;</code> into the
                        Day of Defeat console instead.
                    </p>

                    <h4 style={{ marginTop: 32 }}>Completed Matches</h4>
                    {completed.length === 0 ? (
                        <p className="text-muted">No completed matches found.</p>
                    ) : (
                        <MatchTable matches={completed} formatDate={formatDate} />
                    )}
                </Col>
            </Row>
        </Container>
    );
}

function MatchTable({ matches, formatDate }) {
    return (
        <Table striped bordered hover size="sm" style={{ marginTop: 8 }}>
            <thead>
                <tr>
                    <th>Match ID</th>
                    <th>Map</th>
                    <th>Server</th>
                    <th>Started</th>
                    <th>Events</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                {matches.map(m => (
                    <tr key={m.matchId}>
                        <td><code>{m.matchId}</code></td>
                        <td>{m.map}</td>
                        <td>{m.sourceServer}</td>
                        <td>{formatDate(m.startedAt)}</td>
                        <td>{m.eventCount}</td>
                        <td>
                            <a href={`/screen?match=${encodeURIComponent(m.matchId)}&replay=true`}>
                                Replay
                            </a>
                        </td>
                    </tr>
                ))}
            </tbody>
        </Table>
    );
}

export default MatchPicker;
