import React from 'react';
import { Container, Row, Col } from 'react-bootstrap';

class Welcome extends React.Component {
    render() {
        return (
            <Container style={{ marginTop: '40px' }}>
                <Row>
                    <Col>
                        <h2>DoD HUD Observer</h2>
                        <p style={{ marginTop: '16px' }}>
                            Day of Defeat 1.3 live broadcast overlay for OBS.
                        </p>
                        <ul style={{ marginTop: '16px', lineHeight: '2' }}>
                            <li><a href="/screen">HUD overlay</a> — open this as an OBS browser source</li>
                            <li><a href="/teams">Teams</a></li>
                            <li><a href="/players">Players</a></li>
                            <li><a href="/matches">Matches</a></li>
                        </ul>
                    </Col>
                </Row>
            </Container>
        );
    }
}

export default Welcome;