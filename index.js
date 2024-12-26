/**
 * Cloudflare Calls Backend Server (Express)
 *
 * Illustrates how to:
 * 1. Store each participant’s local track offers in memory.
 * 2. Perform the Cloudflare Calls track negotiation on the server.
 */

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');
const http = require('http');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const port = process.env.PORT || 5000;
const CLOUDFLARE_APP_ID = process.env.CLOUDFLARE_APP_ID;
const CLOUDFLARE_APP_SECRET = process.env.CLOUDFLARE_APP_SECRET;
const CLOUDFLARE_BASE_PATH = `https://rtc.live.cloudflare.com/v1/apps/${CLOUDFLARE_APP_ID}`;

/**
 * In-memory storage for rooms and participants.
 * @typedef {Object} Room
 * @property {string} userId - Unique identifier for the user.
 * @property {string} sessionId - Unique identifier for the session.
 * @property {number} createdAt - Timestamp when the participant was added.
 * @property {Array} offers - Array of offer objects.
 */

/**
 * @type {Object.<string, Array<Room>>}
 */
const rooms = {};

const wsConnections = {};

/* ------------------------------------------------------------------
   Basic endpoints
------------------------------------------------------------------ */

/**
 * @api {post} /api/rooms Create a new room
 * @apiName CreateRoom
 * @apiGroup Rooms
 *
 * @apiSuccess {String} roomId The unique ID of the created room.
 * @apiError (404) NotFound Room not found.
 */
app.post('/api/rooms', (req, res) => {
    const roomId = crypto.randomUUID();
    rooms[roomId] = [];
    res.json({ roomId });
});

/**
 * @api {get} /inspect-rooms Inspect all rooms (development only)
 * @apiName InspectRooms
 * @apiGroup Rooms
 * @apiDescription Retrieve all rooms and their participants (development mode only).
 *
 * @apiSuccess {Object} rooms Object containing all rooms and participants.
 */
if (process.env.NODE_ENV === 'development') {
    app.get('/inspect-rooms', (req, res) => {
        res.json(rooms);
    });
}

/**
 * @api {post} /api/rooms/:roomId/join Join a room
 * @apiName JoinRoom
 * @apiGroup Rooms
 *
 * @apiParam {String} roomId The ID of the room to join.
 * @apiBody {String} userId The user's unique identifier.
 *
 * @apiSuccess {String} sessionId The session ID of the participant.
 * @apiSuccess {Array} otherSessions List of other participants in the room.
 * @apiError (404) NotFound Room not found.
 * @apiError (500) ServerError Failed to create Calls session.
 */
app.post('/api/rooms/:roomId/join', async (req, res) => {
    const { roomId } = req.params;
    const { userId } = req.body;
    if (!rooms[roomId]) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const response = await fetch(`${CLOUDFLARE_BASE_PATH}/sessions/new`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CLOUDFLARE_APP_SECRET}` }
    });
    const sessionResponse = await response.json();
    if (!sessionResponse.sessionId) {
        return res.status(500).json({ error: 'Could not create Calls session' });
    }

    const participant = {
        userId,
        sessionId: sessionResponse.sessionId,
        createdAt: Date.now(),
        publishedTracks: []
    };
    rooms[roomId].push(participant);

    const otherParticipants = rooms[roomId]
        .filter(p => p.userId !== userId)
        .map(p => ({
            userId: p.userId,
            sessionId: p.sessionId,
            publishedTracks: p.publishedTracks
        }));

    setTimeout(() => {
        broadcastToRoom(roomId, {
            type: 'participant-joined',
            payload: {
                userId,
                sessionId: participant.sessionId,
            },
        }, userId);
    }, 1000);

    res.json({
        sessionId: participant.sessionId,
        otherSessions: otherParticipants
    });
});

/**
 * @api {post} /api/rooms/:roomId/sessions/:sessionId/publish Publish local tracks
 * @apiName PublishTracks
 * @apiGroup Sessions
 *
 * @apiParam {String} roomId The ID of the room.
 * @apiParam {String} sessionId The session ID of the participant.
 * @apiBody {Object} offer The SDP offer.
 * @apiBody {Array} tracks Array of track objects.
 *
 * @apiSuccess {Object} data Response from Cloudflare Calls API.
 * @apiError (404) NotFound Session not found in this room.
 */
app.post('/api/rooms/:roomId/sessions/:sessionId/publish', async (req, res) => {
    const { roomId, sessionId } = req.params;
    const { offer, tracks } = req.body;

    const participants = rooms[roomId] || [];
    const participant = participants.find(p => p.sessionId === sessionId);
    if (!participant) {
        return res.status(404).json({ error: 'Session not found in this room' });
    }

    for (const t of tracks) {
        if (!participant.publishedTracks.includes(t.trackName)) {
            participant.publishedTracks.push(t.trackName);
        }
    }

    const cfResp = await fetch(`${CLOUDFLARE_BASE_PATH}/sessions/${sessionId}/tracks/new`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${CLOUDFLARE_APP_SECRET}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            sessionDescription: offer,
            tracks
        })
    });
    const data = await cfResp.json();
    return res.json(data);
});

/**
 * @api {post} /api/rooms/:roomId/sessions/:sessionId/pull Pull remote tracks
 * @apiName PullTracks
 * @apiGroup Sessions
 *
 * @apiParam {String} roomId The ID of the room.
 * @apiParam {String} sessionId The session ID of the participant.
 * @apiBody {String} remoteSessionId The session ID of the remote participant.
 * @apiBody {String} trackName The exact name of the track to pull.
 *
 * @apiSuccess {Object} data Response from Cloudflare Calls API.
 * @apiError (404) NotFound Room or Session not found.
 */
app.post('/api/rooms/:roomId/sessions/:sessionId/pull', async (req, res) => {
    const { roomId, sessionId } = req.params;
    const { remoteSessionId, trackName } = req.body;

    const participants = rooms[roomId] || [];
    const participant = participants.find(p => p.sessionId === sessionId);
    if (!participant) {
        return res.status(404).json({ error: 'Session not found in this room' });
    }

    const tracksToPull = [{
        location: 'remote',
        sessionId: remoteSessionId,
        trackName
    }];

    const cfResp = await fetch(`${CLOUDFLARE_BASE_PATH}/sessions/${sessionId}/tracks/new`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${CLOUDFLARE_APP_SECRET}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ tracks: tracksToPull })
    });
    const data = await cfResp.json();
    return res.json(data);
});

/**
 * @apiDefine Error404
 * @apiError 404 Room or Participant not found.
 */

/**
 * @apiDefine Error400
 * @apiError 400 Error from Cloudflare Calls API.
 */

/* ------------------------------------------------------------------
   Renegotiate, Publish, and Data Channels Endpoints
------------------------------------------------------------------ */

/**
 * @api {put} /api/rooms/:roomId/sessions/:sessionId/renegotiate Renegotiate Session
 * @apiName RenegotiateSession
 * @apiGroup Sessions
 * @apiDescription Renegotiates the session by updating the session description.
 *
 * @apiParam {String} roomId The ID of the room.
 * @apiParam {String} sessionId The session ID of the participant.
 *
 * @apiParam (Request Body) {Object} body The request body containing sdp and type.
 * @apiParam (Request Body) {String} body.sdp The SDP offer/answer.
 * @apiParam (Request Body) {String} body.type The type of the SDP ('offer' or 'answer').
 *
 * @apiSuccess {Object} session Updated session information.
 *
 * @apiUse Error400
 */
app.put('/api/rooms/:roomId/sessions/:sessionId/renegotiate', async (req, res) => {
    const { sessionId } = req.params;
    const { sdp, type } = req.body; // The client's answer
    const body = {
        sessionDescription: { sdp, type },
    };
    const cfResp = await fetch(`${CLOUDFLARE_BASE_PATH}/sessions/${sessionId}/renegotiate`, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${CLOUDFLARE_APP_SECRET}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const result = await cfResp.json();
    if (result.errorCode) {
        return res.status(400).json(result);
    }
    res.json(result);
});

/**
 * @api {post} /api/rooms/:roomId/sessions/:sessionId/publish Publish Tracks
 * @apiName PublishTracks
 * @apiGroup Sessions
 * @apiDescription Publishes local tracks for a session and notifies other participants.
 *
 * @apiParam {String} roomId The ID of the room.
 * @apiParam {String} sessionId The session ID of the participant.
 *
 * @apiParam (Request Body) {Object} body The request body containing offer and tracks.
 * @apiParam (Request Body) {Object} body.offer The SDP offer.
 * @apiParam (Request Body) {Array} body.tracks Array of track objects.
 *
 * @apiSuccess {Object} response Response from Cloudflare Calls API.
 *
 * @apiUse Error404
 */
app.post('/api/rooms/:roomId/sessions/:sessionId/publish', async (req, res) => {
    const { roomId, sessionId } = req.params;
    const { offer, tracks } = req.body;

    const participants = rooms[roomId] || [];
    const participant = participants.find(p => p.sessionId === sessionId);
    if (!participant) {
        return res.status(404).json({ error: 'Session not found in this room' });
    }

    // Store these trackName(s) in participant.publishedTracks
    for (const t of tracks) {
        if (!participant.publishedTracks.includes(t.trackName)) {
            participant.publishedTracks.push(t.trackName);
        }
    }

    // Now call Cloudflare to finalize the push
    const cfResp = await fetch(`${CLOUDFLARE_BASE_PATH}/sessions/${sessionId}/tracks/new`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${CLOUDFLARE_APP_SECRET}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            sessionDescription: offer,
            tracks
        })
    });
    const data = await cfResp.json();
    if (data.sessionDescription) {
        // Emit a 'track-published' event to other participants in the room
        broadcastToRoom(roomId, {
            type: 'track-published',
            payload: {
                sessionId,
                trackNames: tracks.map(t => t.trackName)
            }
        }, participant.userId);
    }
    return res.json(data);
});

/**
 * @api {post} /api/rooms/:roomId/sessions/:sessionId/datachannels/new Manage Data Channels
 * @apiName ManageDataChannels
 * @apiGroup DataChannels
 * @apiDescription Creates or subscribes to data channels in the Cloudflare Calls SFU.
 *
 * @apiParam {String} roomId The ID of the room.
 * @apiParam {String} sessionId The session ID of the participant.
 *
 * @apiParam (Request Body) {Array} dataChannels Array of data channel objects.
 *
 * @apiSuccess {Object} response Response from Cloudflare Calls API.
 *
 * @apiUse Error404
 * @apiUse Error400
 */
app.post('/api/rooms/:roomId/sessions/:sessionId/datachannels/new', async (req, res) => {
    const { roomId, sessionId } = req.params;
    const { dataChannels } = req.body;

    // Check that this room and session exist in memory
    const participants = rooms[roomId] || [];
    const participant = participants.find(p => p.sessionId === sessionId);
    if (!participant) {
        return res.status(404).json({ error: 'Session not found in this room' });
    }

    // Forward this datachannels request to Cloudflare
    // The official CF endpoint is:
    //   POST /v1/apps/:APP_ID/sessions/:sessionId/datachannels/new
    // with a JSON body { dataChannels: [...] }.

    const cfUrl = `${CLOUDFLARE_BASE_PATH}/sessions/${sessionId}/datachannels/new`;
    const cfResp = await fetch(cfUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${CLOUDFLARE_APP_SECRET}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ dataChannels })
    });

    const data = await cfResp.json();
    if (data.errorCode) {
        return res.status(400).json(data);
    }

    // Optionally, if the user is publishing a channel, you could record that in `participant.publishedDataChannels` in memory
    dataChannels.forEach(dc => {
        if (dc.location === 'local') {
            // E.g. store in participant.publishedDataChannels = [...(existing), dc.dataChannelName];
        }
    });

    res.json(data); // Return the CF Calls response to the client
});

/* ------------------------------------------------------------------
   Participants and Tracks Endpoints
------------------------------------------------------------------ */

/**
 * @api {get} /api/rooms/:roomId/participants Get Participants
 * @apiName GetParticipants
 * @apiGroup Participants
 * @apiDescription Retrieves a list of all participants in a specified room along with their published tracks.
 *
 * @apiParam {String} roomId The ID of the room.
 *
 * @apiSuccess {Object} participants An object containing an array of participants.
 *
 * @apiUse Error404
 */
app.get('/api/rooms/:roomId/participants', (req, res) => {
    const { roomId } = req.params;
    const room = rooms[roomId];
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const participants = room.map(participant => ({
        userId: participant.userId,
        sessionId: participant.sessionId,
        publishedTracks: participant.publishedTracks
    }));

    res.json({ participants });
});

/**
 * @api {get} /api/rooms/:roomId/participant/:sessionId/tracks Get Participant Tracks
 * @apiName GetParticipantTracks
 * @apiGroup Participants
 * @apiDescription Retrieves a list of tracks for a specific participant in a room.
 *
 * @apiParam {String} roomId The ID of the room.
 * @apiParam {String} sessionId The session ID of the participant.
 *
 * @apiSuccess {Object} publishedTracks Array of published track names.
 *
 * @apiUse Error404
 */

/* Note: This endpoint was previously listed above Renegotiate, Publish, and Data Channels.
   For better organization, it's moved under the Participants group.
*/
app.get('/api/rooms/:roomId/participant/:sessionId/tracks', async (req, res) => {
    const { sessionId, roomId } = req.params;

    if (!rooms[roomId]) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const participants = rooms[roomId].filter(x => x.sessionId === sessionId);

    if (!participants.length) {
        return res.status(404).json({ error: 'Participant not found' });
    }

    res.json(participants[0].publishedTracks);
});

/* ------------------------------------------------------------------
   ICE Servers Endpoint
------------------------------------------------------------------ */

/**
 * @api {get} /api/ice-servers Get ICE Servers
 * @apiName GetICEServers
 * @apiGroup ICEServers
 * @apiDescription Generates TURN credentials and returns the iceServers configuration.
 *
 * @apiSuccess {Object} iceServers iceServers configuration.
 *
 * @apiError 500 Failed to generate ICE servers.
 */
app.get('/api/ice-servers', (req, res) => {
    if (!process.env.CLOUDFLARE_TURN_ID || !process.env.CLOUDFLARE_TURN_TOKEN) {
        return res.json({
            iceServers: [
                { urls: 'stun:stun.cloudflare.com:3478' },
            ]
        });
    }

    try {
        const lifetime = 600; // Credentials valid for 10 minutes (600 seconds)
        const timestamp = Math.floor(Date.now() / 1000) + lifetime;
        const username = `${timestamp}:${process.env.CLOUDFLARE_TURN_ID}`;

        // Create HMAC-SHA256 hash using CLOUDFLARE_TURN_TOKEN as the key
        const hmac = crypto.createHmac('sha256', process.env.CLOUDFLARE_TURN_TOKEN);
        hmac.update(username);
        const credential = hmac.digest('base64');

        const iceServers = {
            iceServers: [
                { urls: 'stun:stun.cloudflare.com:3478' },
                {
                    urls: 'turn:turn.cloudflare.com:3478?transport=udp',
                    username,
                    credential
                },
                {
                    urls: 'turn:turn.cloudflare.com:3478?transport=tcp',
                    username,
                    credential
                },
                {
                    urls: 'turns:turn.cloudflare.com:5349?transport=tcp',
                    username,
                    credential
                }
            ]
        };

        res.json(iceServers);
    } catch (error) {
        console.error('Error generating ICE servers:', error);
        res.status(500).json({ error: 'Failed to generate ICE servers' });
    }
});

/* ------------------------------------------------------------------
   Basic WebSocket for "participant joined" etc.
------------------------------------------------------------------ */

/**
 * Sets up the WebSocket server and handles incoming connections and messages.
 */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('New WebSocket connection.');
    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch {
            console.warn('Received invalid JSON message via WebSocket.');
            return;
        }
        switch (data.type) {
            case 'join-websocket':
                handleWSJoin(ws, data.payload);
                break;
            case 'data-message':
                handleDataMessage(ws, data.payload);
                break;
            default:
                console.warn(`Unknown message type: ${data.type}`);
                break;
        }
    });
    ws.on('close', () => handleWSDisconnect(ws));
});

/**
 * Handles incoming data messages from clients and broadcasts them.
 * @param {WebSocket} ws - The WebSocket connection from the sender.
 * @param {Object} payload - The payload containing from, to, and message.
 */
function handleDataMessage(ws, payload) {
    const { from, to, message } = payload;
    if (!from || !message) {
        console.warn('Invalid data-message payload:', payload);
        return;
    }

    let targetUserIds = [];

    if (to === 'all') {
        // Broadcast to all participants in the room except the sender
        const roomId = getRoomIdByUserId(from);
        if (!roomId) {
            console.warn(`Room not found for userId: ${from}`);
            return;
        }
        targetUserIds = Object.keys(wsConnections[roomId] || {}).filter(userId => userId !== from);
        broadcastToRoom(roomId, {
            type: 'data-message',
            payload: {
                from,
                to: 'all',
                message
            }
        }, from);
    } else {
        // Send to a specific participant
        const targetWs = getWebSocketByUserId(to);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({
                type: 'data-message',
                payload: {
                    from,
                    to,
                    message
                }
            }));
            console.log(`Data message from ${from} to ${to}:`, message);
        } else {
            console.warn(`Target userId ${to} is not connected.`);
        }
    }
}

/**
 * Utility function to get roomId by userId.
 * Assumes each user is in only one room.
 * @param {string} userId - The user's unique identifier.
 * @returns {string|null} - The room ID if found, otherwise null.
 */
function getRoomIdByUserId(userId) {
    for (const [roomId, users] of Object.entries(wsConnections)) {
        if (users[userId]) {
            return roomId;
        }
    }
    return null;
}

/**
 * Utility function to get WebSocket connection by userId.
 * @param {string} userId - The user's unique identifier.
 * @returns {WebSocket|null} - The WebSocket connection if found, otherwise null.
 */
function getWebSocketByUserId(userId) {
    for (const users of Object.values(wsConnections)) {
        if (users[userId]) {
            return users[userId];
        }
    }
    return null;
}

/**
 * Handles a WebSocket join request by adding the user to the wsConnections.
 * @param {WebSocket} ws - The WebSocket connection.
 * @param {Object} payload - The payload containing roomId and userId.
 * @param {string} payload.roomId - The ID of the room to join.
 * @param {string} payload.userId - The user's unique identifier.
 */
function handleWSJoin(ws, { roomId, userId }) {
    if (!roomId || !userId) {
        console.warn('Missing roomId/userId in WS join');
        return;
    }
    if (!wsConnections[roomId]) {
        wsConnections[roomId] = {};
    }
    wsConnections[roomId][userId] = ws;
    console.log(`User ${userId} joined room ${roomId} via WS`);
}

/**
 * Handles WebSocket disconnections by removing the user from wsConnections.
 * @param {WebSocket} ws - The WebSocket connection that was closed.
 */
function handleWSDisconnect(ws) {
    for (const [rId, userMap] of Object.entries(wsConnections)) {
        for (const [uId, sock] of Object.entries(userMap)) {
            if (sock === ws) {
                console.log(`User ${uId} disconnected from room ${rId}`);
                delete wsConnections[rId][uId];
            }
        }
    }
}

/**
 * Broadcasts a message to all participants in a room, optionally excluding a specific user.
 * @param {string} roomId - The ID of the room.
 * @param {Object} message - The message object to broadcast.
 * @param {string|null} excludeUserId - The user ID to exclude from broadcasting.
 */
function broadcastToRoom(roomId, message, excludeUserId = null) {
    if (!wsConnections[roomId]) return;
    for (const [userId, ws] of Object.entries(wsConnections[roomId])) {
        if (userId === excludeUserId) continue;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    }
}

server.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
});
