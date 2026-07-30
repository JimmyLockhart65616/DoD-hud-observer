import React from 'react';
import {
  BrowserRouter as Router,
  Switch,
  Route,
} from "react-router-dom";

//import io from 'socket.io-client';


import './App.css';

import Routes from './routes/Routes';
import Welcome from './components/main/Welcome';
import Stream from './components/stream/Stream';
import Screen from './components/screen/Example';
import Caster from './components/caster/Caster';
import MatchPicker from './components/matchPicker/MatchPicker';
import Help from './components/help/Help';


// Pages that own their whole viewport and must not get the Bootstrap navbar:
// /screen is the OBS browser source, /caster is the casters' reference monitor.
const CHROME_FREE_PATHS = ['/screen', '/caster'];

function App() {

  return (
      <Router>

        {!CHROME_FREE_PATHS.includes(window.location.pathname) ? <Routes /> : null}

        <Switch>
          <Route path="/watch" component={MatchPicker} />
          <Route path="/stream/:id" component={Stream} />
          <Route path="/screen" component={Screen} />
          <Route path="/caster" component={Caster} />
          <Route path="/help" component={Help} />
          <Route path="/" component={Welcome} />
        </Switch>
      </Router>
  );

}


export default App;
