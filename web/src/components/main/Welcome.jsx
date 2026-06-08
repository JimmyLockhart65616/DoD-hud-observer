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