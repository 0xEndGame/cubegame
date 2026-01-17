const path = require('path');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const GRID_X = 5;
const GRID_Y = 4;
const GRID_Z = 5;

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static assets from the project root (index.html, game.js, style.css)
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const state = {
    cubes: {},
    clickedCount: 0,
};

function cubeId(x, y, z) {
    return `cube-${x}-${y}-${z}`;
}

function initState() {
    state.clickedCount = 0;
    for (let x = 0; x < GRID_X; x++) {
        for (let y = 0; y < GRID_Y; y++) {
            for (let z = 0; z < GRID_Z; z++) {
                state.cubes[cubeId(x, y, z)] = true;
            }
        }
    }
}

function broadcast(data) {
    const payload = JSON.stringify(data);
    wss.clients.forEach((client) => {
        if (client.readyState === 1) {
            client.send(payload);
        }
    });
}

function broadcastActive() {
    const count = Array.from(wss.clients).filter(c => c.readyState === 1).length;
    broadcast({ type: 'active', count });
}

function sendError(ws, message) {
    ws.send(JSON.stringify({ type: 'error', message }));
}

function handleRemove(ws, message) {
    const { id, wallet } = message;
    if (!id || !(id in state.cubes)) {
        sendError(ws, 'Invalid cube id');
        return;
    }
    if (!state.cubes[id]) {
        // Already removed; no-op to keep idempotent
        return;
    }

    state.cubes[id] = false;
    state.clickedCount += 1;

    broadcast({
        type: 'cube_removed',
        id,
        clickedCount: state.clickedCount,
        wallet: wallet || null,
    });
}

function handleReset() {
    initState();
    broadcast({
        type: 'init',
        cubes: state.cubes,
        clickedCount: state.clickedCount,
    });
}

wss.on('connection', (ws) => {
    ws.send(JSON.stringify({
        type: 'init',
        cubes: state.cubes,
        clickedCount: state.clickedCount,
    }));

    broadcastActive();

    ws.on('message', (data) => {
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch (err) {
            sendError(ws, 'Invalid JSON');
            return;
        }

        switch (message.type) {
            case 'remove':
                handleRemove(ws, message);
                break;
            case 'reset':
                handleReset();
                break;
            default:
                sendError(ws, 'Unknown message type');
        }
    });

    ws.on('close', () => {
        broadcastActive();
    });
});

initState();

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
