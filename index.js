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
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const crypto = require('crypto');
const http = require('http');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const AUTH_REQUIRED = true; // You can turn off auth for your demo if you want
const port = process.env.PORT || 5000;
const CLOUDFLARE_APP_ID = process.env.CLOUDFLARE_APP_ID;
const CLOUDFLARE_APP_SECRET = process.env.CLOUDFLARE_APP_SECRET;
const SECRET_KEY = process.env.JWT_SECRET || 'thisisjustademokey';
const CLOUDFLARE_CALLS_BASE_URL = process.env.CLOUDFLARE_APPS_URL || 'https://rtc.live.cloudflare.com/v1/apps';
const CLOUDFLARE_BASE_PATH = `${CLOUDFLARE_CALLS_BASE_URL}/${CLOUDFLARE_APP_ID}`;

// Middleware to verify token from the Authorization header
function verifyToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!AUTH_REQUIRED) return next();

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        req.user = decoded; // Attach decoded token data to the request object
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Forbidden: Invalid token' });
    }
}

// Example token generation endpoint
// Has no usefulness in production, just facilitates the demo
app.post('/auth/token', (req, res) => {
    const { username } = req.body;
    const userId = crypto.randomUUID(); // Generate unique user ID

    // Generate a token with arbitrary JSON payload
    const token = jwt.sign({ 
        userId,
        username, 
        role: 'demo',
        isModerator: true // In production, this would come from your database
    }, SECRET_KEY, { 
        expiresIn: '8h' 
    });

    // Store initial user info
    users.set(userId, {
        userId,
        username,
        isModerator: true,
        role: 'demo'
    });

    res.json({ token });
});

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
const rooms = new Map();  // Using Map instead of plain object for better key handling

const wsConnections = {};

// Add this near the top with other in-memory storage
const users = new Map(); // Store user info

// Helper function to serialize room data
function serializeRoom(roomId, roomData) {
    return {
        roomId,
        name: roomData.name || '',
        metadata: roomData.metadata || {},
        participantCount: roomData.participants.length,
        createdAt: roomData.createdAt
    };
}

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
app.post('/api/rooms', verifyToken, (req, res) => {
    const roomId = crypto.randomUUID();
    const { name, metadata } = req.body;
    
    rooms.set(roomId, {
        name: name || '',
        metadata: metadata || {},
        participants: [],
        createdAt: Date.now()
    });
    
    res.json(serializeRoom(roomId, rooms.get(roomId)));
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
        const debug = {
            rooms: Object.fromEntries(rooms),
            roomCount: rooms.size,
            users: Array.from(users.entries()),
            wsConnections: Object.keys(wsConnections)
        };

        res.json(debug);
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
app.post('/api/rooms/:roomId/join', verifyToken, async (req, res) => {
    const { roomId } = req.params;
    const { userId } = req.user;

    if (!rooms.has(roomId)) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const room = rooms.get(roomId);
    
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

    room.participants.push(participant);
    rooms.set(roomId, room);

    const otherParticipants = room.participants
        .filter(p => p.userId !== userId)
        .map(p => ({
            userId: p.userId,
            sessionId: p.sessionId,
            publishedTracks: p.publishedTracks
        }));

    broadcastToRoom(roomId, {
        type: 'participant-joined',
        payload: {
            userId,
            username: users.get(userId).username,
            sessionId: participant.sessionId,
        },
    }, userId);

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
app.post('/api/rooms/:roomId/sessions/:sessionId/publish', verifyToken, async (req, res) => {
    const { roomId, sessionId } = req.params;
    const { offer, tracks } = req.body;

    const room = rooms.get(roomId);
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const participant = room.participants.find(p => p.sessionId === sessionId);
    if (!participant) {
        return res.status(404).json({ error: 'Session not found in this room' });
    }

    // Store these trackName(s) in participant.publishedTracks
    for (const t of tracks) {
        if (!participant.publishedTracks.includes(t.trackName)) {
            participant.publishedTracks.push(t.trackName);
        }
    }

    rooms.set(roomId, room);
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
 * @api {post} /api/rooms/:roomId/sessions/:sessionId/unpublish Unpublish Track
 * @apiName UnpublishTrack
 * @apiGroup Sessions
 * 
 * @apiParam {String} roomId The ID of the room
 * @apiParam {String} sessionId The session ID of the track owner
 * 
 * @apiHeader {String} Authorization Bearer token
 * 
 * @apiError (403) Forbidden User is not authorized to force unpublish others' tracks
 */
app.post('/api/rooms/:roomId/sessions/:sessionId/unpublish', verifyToken, async (req, res) => {
    try {
        const { roomId, sessionId } = req.params;
        const { trackName, mid, force } = req.body;

        // If trying to force unpublish someone else's track
        if (force && sessionId !== req.user.sessionId) {
            // Check if user is moderator
            if (!req.user.isModerator) {
                return res.status(403).json({ 
                    errorCode: 'NOT_AUTHORIZED',
                    errorDescription: 'Only moderators can force unpublish other participants\' tracks'
                });
            }
        }

        console.log('Unpublishing track:', { roomId, sessionId, trackName, mid });

        if (!mid) {
            return res.status(400).json({ 
                errorCode: 'INVALID_REQUEST',
                errorDescription: 'mid is required to unpublish a track.'
            });
        }

        // Call Cloudflare API to close the track
        const cfUrl = `${CLOUDFLARE_BASE_PATH}/sessions/${sessionId}/tracks/close`;
        console.log('Calling Cloudflare API:', cfUrl);
        
        const requestBody = {
            tracks: [{
                mid: mid.toString()
            }],
            force: Boolean(force)
        };

        console.log('Request body:', JSON.stringify(requestBody, null, 2));
        
        const response = await fetch(cfUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${CLOUDFLARE_APP_SECRET}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        const data = await response.json();
        console.log('Cloudflare API response:', data);

        // Update local state and broadcast
        const room = rooms.get(roomId);
        if (room) {
            room.participants = room.participants.filter(p => p.sessionId !== sessionId);
            console.log('Updated participants:', room.participants);
        }

        broadcastToRoom(roomId, {
            type: 'track-unpublished',
            payload: { sessionId, trackName }
        }, sessionId);

        res.json(data);

    } catch (error) {
        console.error('Detailed error unpublishing track:', error);
        res.status(500).json({ 
            errorCode: 'UNPUBLISH_ERROR',
            errorDescription: error.message 
        });
    }
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
app.post('/api/rooms/:roomId/sessions/:sessionId/pull', verifyToken, async (req, res) => {
    const { roomId, sessionId } = req.params;
    const { remoteSessionId, trackName } = req.body;

    const room = rooms.get(roomId);
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const participant = room.participants.find(p => p.sessionId === sessionId);
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
 * @apiGroup Session
 * @apiDescription Renegotiate an existing session with new SDP offer
 * @apiParam {String} roomId Room identifier
 * @apiParam {String} sessionId Session identifier
 * @apiBody {Object} sessionDescription WebRTC session description
 * @apiBody {String} sessionDescription.sdp SDP offer
 * @apiBody {String} sessionDescription.type Type of SDP message
 *
 * @apiSuccess {Object} data Response from Cloudflare Calls API
 */
app.put('/api/rooms/:roomId/sessions/:sessionId/renegotiate', verifyToken, async (req, res) => {
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
 * @apiGroup Session
 * @apiDescription Publish media tracks to the room
 * @apiParam {String} roomId Room identifier
 * @apiParam {String} sessionId Session identifier
 * @apiBody {Object} offer WebRTC offer for publishing
 * @apiBody {Array} tracks Array of track information
 * @apiBody {String} tracks.location Track location (local/remote)
 * @apiBody {String} tracks.trackName Unique track identifier
 *
 * @apiSuccess {Object} data Response from Cloudflare Calls API
 */
app.post('/api/rooms/:roomId/sessions/:sessionId/publish', verifyToken, async (req, res) => {
    const { roomId, sessionId } = req.params;
    const { offer, tracks } = req.body;

    const room = rooms.get(roomId);
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const participant = room.participants.find(p => p.sessionId === sessionId);
    if (!participant) {
        return res.status(404).json({ error: 'Session not found in this room' });
    }

    // Store these trackName(s) in participant.publishedTracks
    for (const t of tracks) {
        if (!participant.publishedTracks.includes(t.trackName)) {
            participant.publishedTracks.push(t.trackName);
        }
    }

    rooms.set(roomId, room);
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
 * @apiGroup Session
 * @apiDescription Manage data channel subscriptions
 * @apiParam {String} roomId Room identifier
 * @apiParam {String} sessionId Session identifier
 * @apiBody {Array} dataChannels Array of data channel names
 *
 * @apiSuccess {Object} response Response from Cloudflare Calls API.
 *
 * @apiUse Error404
 * @apiUse Error400
 */
app.post('/api/rooms/:roomId/sessions/:sessionId/datachannels/new', verifyToken, async (req, res) => {
    const { roomId, sessionId } = req.params;
    const { dataChannels } = req.body;

    // Check that this room and session exist in memory
    const room = rooms.get(roomId);
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
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
app.get('/api/rooms/:roomId/participants', verifyToken, (req, res) => {
    const { roomId } = req.params;
    
    if (!rooms.has(roomId)) {
        return res.status(404).json({ error: 'Room not found' });
    }
    
    const room = rooms.get(roomId);
    res.json({ participants: room.participants });
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
app.get('/api/rooms/:roomId/participant/:sessionId/tracks', verifyToken, async (req, res) => {
    const { sessionId, roomId } = req.params;

    if (!rooms.has(roomId)) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const room = rooms.get(roomId);
    const participant = room.participants.find(p => p.sessionId === sessionId);

    if (!participant) {
        return res.status(404).json({ error: 'Participant not found' });
    }

    res.json(participant.publishedTracks);
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
app.get('/api/ice-servers', verifyToken, (req, res) => {
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
    // ws.setNoDelay(true);

    ws.isAuthenticated = false;

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
                if (AUTH_REQUIRED && !ws.isAuthenticated) {
                    ws.send(JSON.stringify({ error: 'Unauthorized: Please authenticate first' }));
                    console.log('Unauthenticated websocket request to send data-message');
                    return;
                }
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

    // Get room ID from the session ID
    const roomId = getRoomIdBySessionId(from);
    if (!roomId) {
        console.warn(`Room not found for session: ${from}`);
        return;
    }

    // Broadcast to all participants in the room except the sender
    broadcastToRoom(roomId, {
        type: 'data-message',
        payload: {
            from,
            data: message
        }
    }, from);
}

/**
 * Utility function to get roomId by userId.
 * Assumes each user is in only one room.
 * @param {string} userId - The user's unique identifier.
 * @returns {string|null} - The room ID if found, otherwise null.
 */
function getRoomIdByUserId(userId) {
    for (const [roomId, room] of rooms.entries()) {
        if (room.participants.find(p => p.userId === userId)) {
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
 * Handles a WebSocket join request by authenticating and adding the user to wsConnections.
 * @param {WebSocket} ws - The WebSocket connection.
 * @param {Object} payload - The payload containing roomId, userId, and token.
 * @param {string} payload.roomId - The ID of the room to join.
 * @param {string} payload.userId - The user's unique identifier.
 * @param {string} payload.token - The JWT token for authentication.
 */
function handleWSJoin(ws, { roomId, userId, token }) {
    if (!roomId || !userId || (AUTH_REQUIRED && !token)) {
        console.warn('Missing roomId, userId, or token in WS join');
        ws.send(JSON.stringify({ error: 'Missing roomId, userId, or token' }));
        return;
    }

    try {
        // Verify the token
        if (AUTH_REQUIRED) {
            const user = jwt.verify(token, SECRET_KEY);
        }

        ws.isAuthenticated = true;

        // Add user to the room
        if (!wsConnections[roomId]) {
            wsConnections[roomId] = {};
        }
        wsConnections[roomId][userId] = ws;

        console.log(`User ${userId} joined room ${roomId} via WS`);
        ws.send(JSON.stringify({ message: 'Joined room successfully' }));
    } catch (err) {
        console.warn('Invalid token in WS join:', err.message);
        ws.send(JSON.stringify({ error: 'Invalid or expired token' }));
    }
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
    console.log('Broadcasting to room:', { roomId, message, excludeUserId });
    if (!rooms.has(roomId)) return;

    if (!wsConnections[roomId]) return;
    for (const [userId, ws] of Object.entries(wsConnections[roomId])) {
        if (userId === excludeUserId) continue;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
            console.log('Sent WebSocket message to user:', userId, message);
        }
    }
}

/**
 * @api {get} /api/rooms/:roomId/sessions/:sessionId/state Get Session State
 * @apiName GetSessionState
 * @apiGroup Sessions
 * @apiDescription Retrieves the current state of a session from Cloudflare Calls API.
 *
 * @apiParam {String} roomId The ID of the room.
 * @apiParam {String} sessionId The session ID to query.
 *
 * @apiSuccess {Object} response Session state from Cloudflare Calls API.
 * @apiSuccess {Array} response.tracks List of tracks in the session.
 * @apiSuccess {String} response.tracks.location Track location ('local' or 'remote').
 * @apiSuccess {String} response.tracks.mid Media ID of the track.
 * @apiSuccess {String} response.tracks.trackName Name/ID of the track.
 * @apiSuccess {String} response.tracks.status Track status ('active', 'inactive', or 'waiting').
 *
 * @apiError (500) SessionStateError Failed to retrieve session state.
 * @apiError (403) Forbidden Invalid or missing authentication token.
 */
app.get('/api/rooms/:roomId/sessions/:sessionId/state', verifyToken, async (req, res) => {
    const { roomId, sessionId } = req.params;

    try {
        const response = await fetch(`${CLOUDFLARE_BASE_PATH}/sessions/${sessionId}`, {
            headers: {
                'Authorization': `Bearer ${CLOUDFLARE_APP_SECRET}`
            }
        });

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error getting session state:', error);
        res.status(500).json({ 
            errorCode: 'SESSION_STATE_ERROR',
            errorDescription: error.message 
        });
    }
});

/**
 * @api {get} /api/users/:userId Get User Info
 * @apiName GetUserInfo
 * @apiGroup Users
 * @apiDescription Get information about a user. Returns full info for own user, limited info for others.
 *
 * @apiParam {String} userId User ID or 'me' for current user
 * @apiHeader {String} Authorization Bearer token required
 *
 * @apiSuccess {String} userId User's unique identifier
 * @apiSuccess {String} username User's display name
 * @apiSuccess {Boolean} [isModerator] Whether user is moderator (only included for own user)
 * @apiSuccess {String} [role] User's role (only included for own user)
 *
 * @apiError (403) Forbidden Invalid or missing token
 * @apiError (404) NotFound User not found
 */
app.get('/api/users/:userId', verifyToken, (req, res) => {
    const { userId } = req.params;
    
    // Handle 'me' request
    if (userId === 'me') {
        const userInfo = users.get(req.user.userId);
        if (!userInfo) {
            return res.status(404).json({
                errorCode: 'USER_NOT_FOUND',
                errorDescription: 'Current user not found'
            });
        }
        return res.json(userInfo);
    }

    // Handle specific user request
    const requestedUser = users.get(userId);
    if (!requestedUser) {
        return res.status(404).json({
            errorCode: 'USER_NOT_FOUND',
            errorDescription: 'User not found'
        });
    }

    // Return limited info for other users
    return res.json({
        userId: requestedUser.userId,
        username: requestedUser.username
    });
});

// Add this new endpoint to handle user info requests
/**
 * @api {get} /api/users/:userId Get User Info
 * @apiName GetUserInfo
 * @apiGroup Users
 * @apiDescription Get information about a user. Returns full info for own user, limited info for others.
 *
 * @apiParam {String} userId User ID or 'me' for current user
 * @apiHeader {String} Authorization Bearer token required
 *
 * @apiSuccess {String} userId User's unique identifier
 * @apiSuccess {String} username User's display name
 * @apiSuccess {Boolean} [isModerator] Whether user is moderator (only included for own user)
 * @apiSuccess {String} [role] User's role (only included for own user)
 *
 * @apiError (403) Forbidden Invalid or missing token
 * @apiError (404) NotFound User not found
 */
app.get('/api/users/:userId', verifyToken, (req, res) => {
    const { userId } = req.params;
    
    // Handle 'me' request
    if (userId === 'me') {
        const userInfo = users.get(req.user.userId);
        if (!userInfo) {
            return res.status(404).json({
                errorCode: 'USER_NOT_FOUND',
                errorDescription: 'Current user not found'
            });
        }
        return res.json(userInfo);
    }

    // Handle specific user request
    const requestedUser = users.get(userId);
    if (!requestedUser) {
        return res.status(404).json({
            errorCode: 'USER_NOT_FOUND',
            errorDescription: 'User not found'
        });
    }

    // Return limited info for other users
    return res.json({
        userId: requestedUser.userId,
        username: requestedUser.username
    });
});

// Update leave room to clean up user info
app.post('/api/rooms/:roomId/leave', verifyToken, (req, res) => {
    const { roomId } = req.params;
    const { userId } = req.user;

    // Clean up user's room and session info
    const userInfo = users.get(userId);
    if (userInfo) {
        delete userInfo.sessionId;
        delete userInfo.roomId;
    }

    const room = rooms.get(roomId);
    if (room) {
        room.participants = room.participants.filter(p => p.userId !== userId);
        if (room.participants.length === 0) {
            rooms.delete(roomId);  // Remove empty rooms
        } else {
            rooms.set(roomId, room);
        }
    }

    res.json({ success: true });
});

// Add cleanup when server stops
process.on('SIGINT', () => {
    users.clear();
    process.exit();
});

server.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
});

/**
 * @api {post} /api/rooms/:roomId/sessions/:sessionId/track-status Update Track Status
 * @apiName UpdateTrackStatus
 * @apiGroup Sessions
 * @apiDescription Updates the enabled/disabled status of a track
 *
 * @apiParam {String} roomId The ID of the room
 * @apiParam {String} sessionId The session ID
 * @apiBody {String} trackId The track ID
 * @apiBody {String} kind The track kind ('audio' or 'video')
 * @apiBody {Boolean} enabled Whether the track should be enabled
 * @apiBody {Boolean} [force] Whether to force the status change
 *
 * @apiSuccess {Object} result Operation result
 * @apiError (403) Forbidden Not authorized to update track status
 */
app.post('/api/rooms/:roomId/sessions/:sessionId/track-status', verifyToken, async (req, res) => {
    try {
        const { roomId, sessionId } = req.params;
        const { trackId, kind, enabled, force } = req.body;

        // If trying to force change someone else's track
        if (force && sessionId !== req.user.sessionId) {
            if (!req.user.isModerator) {
                return res.status(403).json({
                    errorCode: 'NOT_AUTHORIZED',
                    errorDescription: 'Only moderators can force change other participants\' tracks'
                });
            }
        }

        // Notify other participants about the track status change
        broadcastToRoom(roomId, {
            type: 'track-status-changed',
            payload: {
                sessionId,
                trackId,
                kind,
                enabled
            }
        }, sessionId);

        res.json({ success: true });
    } catch (error) {
        console.error('Error updating track status:', error);
        res.status(500).json({
            errorCode: 'UPDATE_TRACK_STATUS_ERROR',
            errorDescription: error.message
        });
    }
});

// Add list rooms endpoint
app.get('/api/rooms', verifyToken, (req, res) => {
    const roomList = Array.from(rooms.entries()).map(([roomId, room]) => 
        serializeRoom(roomId, room)
    );
    
    res.json({ rooms: roomList });
});

// Add update metadata endpoint
app.put('/api/rooms/:roomId/metadata', verifyToken, (req, res) => {
    const { roomId } = req.params;
    const { name, metadata } = req.body;
    
    if (!rooms.has(roomId)) {
        return res.status(404).json({ error: 'Room not found' });
    }
    
    const room = rooms.get(roomId);
    
    if (name !== undefined) {
        room.name = name;
    }
    
    if (metadata !== undefined) {
        room.metadata = { ...room.metadata, ...metadata };
    }
    
    rooms.set(roomId, room);
    
    // Notify room participants about the update
    broadcastToRoom(roomId, {
        type: 'room-metadata-updated',
        payload: {
            roomId,
            name: room.name,
            metadata: room.metadata
        }
    });
    
    res.json(serializeRoom(roomId, room));
});

// Update getRoomIdByUserId to use sessionId instead
function getRoomIdBySessionId(sessionId) {
    for (const [roomId, room] of rooms.entries()) {
        if (room.participants.find(p => p.sessionId === sessionId)) {
            return roomId;
        }
    }
    return null;
}
