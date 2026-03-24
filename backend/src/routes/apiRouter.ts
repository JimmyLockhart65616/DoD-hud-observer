import express from 'express';
import config from '../../../config.json';
const router = express.Router();
import * as apiModel from '../models/apiModel';

// Serve default api response
router.get('/', (req, res) => {
    res.json({ status_code: 200, message: 'DoD HUD Observer API' });
});

// Teams
router.get('/teams', (req, res) => {
    res.json({ status_code: 200, message: 'Team list.', teams: apiModel.getAllClans() });
});

router.post('/addclan', (req, res) => {
    const id = apiModel.generateUniqueID();
    if (apiModel.parseClanAdd(id, req.body))
        return res.status(200).json({ id, status_code: 200, message: 'Team added.' });
    return res.status(500).json({ status_code: 500, message: 'Team not added.' });
});

router.get('/view/team/:id', (req, res) => {
    const team = apiModel.parseClanView(req.params.id);
    if (!team) return res.status(404).json({ status_code: 404, message: 'Team not found.' });
    return res.status(200).json({ id: req.params.id, status_code: 200, team_info: team });
});

router.post('/editclan', (req, res) => {
    if (apiModel.parseClanEdit(req.body.id, req.body))
        return res.status(200).json({ id: req.body.id, status_code: 200, message: 'Team updated.' });
    return res.status(500).json({ status_code: 500, message: 'Team not edited.' });
});

// Players
router.get('/players', (req, res) => {
    res.json({
        status_code: 200,
        message: 'Players list.',
        players: apiModel.getAllPlayers() ?? [],
        steam_key: config.auth.STEAM_API_KEY,
    });
});

router.post('/addplayer', (req, res) => {
    const id = apiModel.generateUniqueID();
    if (apiModel.parsePlayerAdd(id, req.body))
        return res.status(200).json({ id, status_code: 200, message: 'Player added.' });
    return res.status(500).json({ status_code: 500, message: 'Player not added.' });
});

router.get('/view/player/:id', (req, res) => {
    const player = apiModel.parsePlayerView(req.params.id);
    if (!player) return res.status(404).json({ status_code: 404, message: 'Player not found.' });
    return res.status(200).json({ id: req.params.id, status_code: 200, player_info: player });
});

router.post('/editplayer', (req, res) => {
    if (apiModel.parsePlayerEdit(req.body.id, req.body))
        return res.status(200).json({ id: req.body.id, status_code: 200, message: 'Player updated.' });
    return res.status(500).json({ status_code: 500, message: 'Player not edited.' });
});

// Matches
router.get('/matches', (req, res) => {
    res.json({ status_code: 200, message: 'Matches list.', matches: apiModel.getAllMatches() ?? [] });
});

router.post('/matches/info', (req, res) => {
    res.json({
        status_code: 200,
        message: 'Match teams info.',
        team_one: apiModel.parseClanView(req.body.team_one),
        team_two: apiModel.parseClanView(req.body.team_two),
    });
});

router.get('/view/match/:id', (req, res) => {
    const match = apiModel.parseMatchView(req.params.id);
    if (!match) return res.status(404).json({ status_code: 404, message: 'Match not found.' });
    return res.status(200).json({ id: req.params.id, status_code: 200, match_info: match });
});

router.post('/addmatch', (req, res) => {
    const id = apiModel.generateUniqueID();
    if (apiModel.parseMatchAdd(id, req.body))
        return res.status(200).json({ id, status_code: 200, message: 'Match added.' });
    return res.status(500).json({ status_code: 500, message: 'Match not added.' });
});

router.post('/editmatch', (req, res) => {
    if (apiModel.parseMatchEdit(req.body.id, req.body))
        return res.status(200).json({ id: req.body.id, status_code: 200, message: 'Match updated.' });
    return res.status(500).json({ status_code: 500, message: 'Match not edited.' });
});

// 404
router.get('*', (req, res) => {
    res.status(404).json({ status_code: 404, message: 'Unknown route.' });
});

export default router;
