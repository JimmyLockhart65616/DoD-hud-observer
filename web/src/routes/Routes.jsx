import React from 'react';
import {Navbar} from 'react-bootstrap';
import {DiGithubBadge} from 'react-icons/di'

class Routes extends React.Component{

    render(){
        return(
            <div>

                <Navbar bg="dark" variant="dark">
                    <Navbar.Brand href="/">
                     KTP DoD HuD
                    </Navbar.Brand>
                    <Navbar.Text className="ml-auto nav-icon" style={{color: '#ffffff'}}>
                        <a href="https://github.com/JimmyLockhart65616/DoD-hud-observer">View this project on <DiGithubBadge size={32}></DiGithubBadge></a>
                    </Navbar.Text>
                </Navbar>
            </div>
        );
    }
}

export default Routes;