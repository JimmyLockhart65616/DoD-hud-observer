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
import MatchPicker from './components/matchPicker/MatchPicker';


function App() {

  return (
      <Router>

        {window.location.pathname !== '/screen' ? <Routes /> : null}

        <Switch>
          <Route path="/watch" component={MatchPicker} />
          <Route path="/stream/:id" component={Stream} />
          <Route path="/screen" component={Screen} />
          <Route path="/" component={Welcome} />
        </Switch>
      </Router>
  );

}


export default App;
