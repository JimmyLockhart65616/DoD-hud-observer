// One-shot probe: print one HLTV-synced server's buffer/clock state.
// Usage: node e2e/repro/qdepth.cjs ["KTP Local Dev #1"] [apiBase]
const http = require('http');
const server = process.argv[2] || 'KTP Local Dev #1';
const base = process.argv[3] || 'http://localhost:3001';
http.get(base + '/api/hltv/status', (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
        try {
            const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const s = (j.servers || []).find((x) => x.server === server);
            const ts = new Date().toTimeString().slice(0, 8);
            if (!s) { console.log(`${ts}  (server '${server}' not found)`); return; }
            console.log(`${ts}  qDepth=${String(s.queueDepth).padStart(4)} online=${s.online} bcastNow=${Math.floor(s.broadcastNow)} actT=${s.activeTime} delay=${s.delaySeconds}`);
        } catch (e) { console.log('parse error: ' + e.message); }
    });
}).on('error', (e) => console.log('http error: ' + e.message));
