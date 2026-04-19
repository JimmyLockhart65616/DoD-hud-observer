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
                    </Col>
                </Row>
            </Container>
        );
    }
}

export default Welcome;