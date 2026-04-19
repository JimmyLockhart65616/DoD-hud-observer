/**
 * Shared event bus for game events.
 *
 * Both the live Socket.IO connection and the Replay engine push events here.
 * SocketStoreComponent subscribes to this instead of the raw socket,
 * so all game-state logic works identically for live and replay.
 */

const listeners = {};

const gameEvents = {
    on(event, fn) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
    },

    off(event, fn) {
        if (!listeners[event]) return;
        listeners[event] = listeners[event].filter(f => f !== fn);
    },

    emit(event, data) {
        if (listeners[event]) {
            listeners[event].forEach(fn => fn(data));
        }
    },

    removeAllListeners() {
        for (const key in listeners) {
            delete listeners[key];
        }
    },
};

export default gameEvents;
