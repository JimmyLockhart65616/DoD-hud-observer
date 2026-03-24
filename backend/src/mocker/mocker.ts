import { createServer } from "http";
import { Server, Socket } from "socket.io";
import MockerClass from "./MockerClass";

const httpServer = createServer();

const io = new Server(httpServer, {
    cors: {
        origin: "http://localhost:3000",
        methods: ["GET", "POST"],
        credentials: true
    },
});

const mocker = new MockerClass();
let started = false;

mocker.on('action', info => {
    const eventName = Array.isArray(info[0]) ? info[0][0] : info[0];
    const data = { event: eventName, ...info[1] };
    console.log(info);
    io.emit(eventName, JSON.stringify(data));
})

io.on("connection", (socket: Socket) => {
    console.log('New connection', socket.id);

    // Start the event sequence on first HUD connection
    if (!started) {
        started = true;
        console.log('[mocker] First client connected — starting event sequence');
        mocker.start();
    }

    socket.on("connect_error", (err) => {
        console.log(`connect_error due to ${err.message}`);
    });
});

httpServer.listen(8000, () => {
    console.log('[mocker] Waiting for client on port 8000...');
});
