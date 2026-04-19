import React, { useEffect, useState } from 'react';
import { Container, Row, Col, Table, Badge } from 'react-bootstrap';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001';

function MatchPicker() {
    const [servers, setServers] = useState([]);
    const [liveMatches, setLiveMatches] = useState([]);
    const [storedMatches, setStoredMatches] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        Promise.all([
            fetch(`${API_URL}/api/servers`).then(r => r.json()),
            fetch(`${API_URL}/api/matches/live`).then(r => r.json()),
            fetch(`${API_URL}/api/matches/stored`).then(r => r.json()),
        ])
            .then(([serverData, live, stored]) => {
                setServers(serverData.servers || []);
                setLiveMatches(live.matches || []);
                const liveIds = new Set((live.active || []).map(String));
                setStoredMatches(
                    (stored.matches || []).filter(m => !liveIds.has(m.matchId))
                );
                setLoading(false);
            })
            .catch(err => {
                console.error('[MatchPicker] fetch error:', err);
                setError(err.message);
                setLoading(false);
            });
    }, []);

    if (loading) return <Container style={{ marginTop: 40 }}><p>Loading...</p></Container>;
    if (error) return <Container style={{ marginTop: 40 }}><p>Error: {error}</p></Container>;

    const formatDate = (iso) => {
        if (!iso) return '\u2014';
        return new Date(iso).toLocaleString();
    };

    const timeAgo = (ms) => {
        if (!ms) return '\u2014';
        const sec = Math.floor((Date.now() - ms) / 1000);
        if (sec < 60) return `${sec}s ago`;
        if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
        return `${Math.floor(sec / 3600)}h ago`;
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
                                    <th>Status</th>
                                    <th>Activity</th>
                                    <th>Current Match</th>
                                    <th>Last Event</th>
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
                                                    <Badge bg="success">Match live</Badge>
                                                ) : (
                                                    <Badge bg="secondary">Idle</Badge>
                                                )}
                                            </td>
                                            <td>
                                                {match ? (
                                                    <>
                                                        <code>{match.matchId}</code>
                                                        {match.map ? <> &middot; {match.map}</> : null}
                                                    </>
                                                ) : (
                                                    <span className="text-muted">&mdash;</span>
                                                )}
                                            </td>
                                            <td>{timeAgo(s.last_seen)}</td>
                                            <td>
                                                <a href={`/screen?server=${encodeURIComponent(s.hostname)}`}>
                                                    {match ? 'Watch Live' : 'Watch'}
                                                </a>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </Table>
                    )}

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
