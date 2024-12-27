/**
 * CloudflareCalls.js
 *
 * High-level library for Cloudflare Calls using SFU,
 * now leveraging WebSocket for data message publish/subscribe flow.
 */

/**
 * Represents the CloudflareCalls library for managing real-time communications.
 */
class CloudflareCalls {
    /**
     * Creates an instance of CloudflareCalls.
     * @param {Object} config - Configuration object.
     * @param {string} config.backendUrl - The backend server URL.
     * @param {string} config.websocketUrl - The WebSocket server URL.
     */
    constructor(config = {}) {
        this.backendUrl = config.backendUrl || '';
        this.websocketUrl = config.websocketUrl || '';

        this.token = null;
        this.roomId = null;
        this.sessionId = null;
        this.userId = this._generateUUID();

        this.userMetadata = {}; // To store user metadata

        this.localStream = null;
        this.peerConnection = null;
        this.ws = null;

        // Callbacks
        this._onRemoteTrackCallback = null;
        this._onDataMessageCallback = null;
        this._onParticipantJoinedCallback = null;
        this._onParticipantLeftCallback = null;
        this._onRemoteTrackUnpublishedCallback = null;

        // Track management
        this.pulledTracks = new Map(); // Map<sessionId, Set<trackName>>
        this.pollingInterval = null; // Reference to the polling interval

        // Device management
        this.availableAudioInputDevices = [];
        this.availableVideoInputDevices = [];
        this.availableAudioOutputDevices = [];
        this.currentAudioOutputDeviceId = null;

        this._renegotiateTimeout = null;
        this.publishedTracks = new Set();

        this.midToSessionId = new Map();
        this.midToTrackName = new Map();
    }

    /**
     * Internal method to perform fetch requests with automatic token inclusion and JSON parsing.
     * @private
     * @param {string} url - The full URL to fetch.
     * @param {Object} options - Fetch options such as method, headers, body, etc.
     * @returns {Promise<Object>} The parsed JSON response.
     * @throws {Error} If the response is not OK.
     */
    async _fetch(url, options = {}) {
        // Initialize headers if not provided
        options.headers = options.headers || {};

        // Add Authorization header if token is set
        if (this.token) {
            options.headers['Authorization'] = `Bearer ${this.token}`;
        }

        try {
            const response = await fetch(url, options);

            // Check if the response status is OK (status in the range 200-299)
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
            }

            return response;
        } catch (error) {
            console.error(`Fetch error for ${url}:`, error);
            throw error;
        }
    }


    /************************************************
     * Callback Registration
     ***********************************************/

    /**
     * Registers a callback for remote track events.
     * @param {Function} callback - The callback function to handle remote tracks.
     */
    onRemoteTrack(callback) {
        this._onRemoteTrackCallback = callback;
    }

    /**
     * Registers a callback for remote track unpublished events.
     * @param {Function} callback - The callback function to handle track unpublished events.
     */
    onRemoteTrackUnpublished(callback) {
        this._onRemoteTrackUnpublishedCallback = callback;
    }

    /**
     * Registers a callback for incoming data messages.
     * @param {Function} callback - The callback function to handle data messages.
     */
    onDataMessage(callback) {
        this._onDataMessageCallback = callback;
    }

    /**
     * Registers a callback for participant joined events.
     * @param {Function} callback - The callback function to handle participant joins.
     */
    onParticipantJoined(callback) {
        this._onParticipantJoinedCallback = callback;
    }

    /**
     * Registers a callback for participant left events.
     * @param {Function} callback - The callback function to handle participant departures.
     */
    onParticipantLeft(callback) {
        this._onParticipantLeftCallback = callback;
    }

    /**
     * Registers a callback for track status changed events.
     * @param {Function} callback - The callback function to handle track status changes.
     */
    onTrackStatusChanged(callback) {
        this._onTrackStatusChangedCallback = callback;
    }

    /************************************************
     * User Metadata Management
     ***********************************************/

    /**
     * Sets the user token for server requests. This should be a JWT token, and will be delivered in Authorization headers (HTTP) and to authenticate websocket join requests.
     * @param {String} token - The metadata to associate with the user.
     */
    setToken(token) {
        this.token = token;
    }

    /**
     * Sets the user metadata and updates it on the server.
     * @param {Object} metadata - The metadata to associate with the user.
     */
    setUserMetadata(metadata) {
        this.userMetadata = metadata;
        this._updateUserMetadataOnServer();
    }

    /**
     * Retrieves the current user metadata.
     * @returns {Object} The user metadata.
     */
    getUserMetadata() {
        return this.userMetadata;
    }

    /**
     * Updates the user metadata on the server.
     * @private
     * @returns {Promise<void>}
     */
    async _updateUserMetadataOnServer() {
        if (!this.roomId || !this.sessionId) {
            console.warn('Cannot update metadata before joining a room.');
            return;
        }

        try {
            const updateUrl = `${this.backendUrl}/api/rooms/${this.roomId}/sessions/${this.sessionId}/metadata`;
            const response = await this._fetch(updateUrl, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.userMetadata)
            });

            if (!response.ok) {
                console.error('Failed to update user metadata on server.');
            } else {
                console.log('User metadata updated on server.');
            }
        } catch (error) {
            console.error('Error updating user metadata:', error);
        }
    }

    /************************************************
     * Room & Session Management
     ***********************************************/

    /**
     * Creates a new room.
     * @async
     * @returns {Promise<string>} The ID of the created room.
     */
    async createRoom() {
        const resp = await this._fetch(`${this.backendUrl}/api/rooms`, { method: 'POST' })
            .then(r => r.json());
        this.roomId = resp.roomId;
        console.log('Created room', this.roomId);
        return this.roomId;
    }

    /**
     * Joins an existing room.
     * @async
     * @param {string} roomId - The ID of the room to join.
     * @param {Object} [metadata={}] - Optional metadata for the user.
     * @returns {Promise<void>}
     */
    async joinRoom(roomId, metadata = {}) {
        this.roomId = roomId;
        this.setUserMetadata(metadata);
        await this._initWebSocket();

        // 1) Ask server to create a CF Calls session
        const joinResp = await this._fetch(`${this.backendUrl}/api/rooms/${roomId}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: this.userId, metadata: this.userMetadata })
        }).then(r => r.json());

        if (!joinResp.sessionId) {
            throw new Error('Failed to join room or retrieve sessionId');
        }
        this.sessionId = joinResp.sessionId;

        // Initialize pulledTracks map
        this.pulledTracks.set(this.sessionId, new Set());

        // 2) Create RTCPeerConnection
        this.peerConnection = await this._createPeerConnection();

        // 3) Get Local Media and Publish Tracks
        if (!this.localStream) {
            this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            console.log('Acquired local media');
        }
        await this._publishTracks();

        // 4) Pull other participants' tracks
        const otherSessions = joinResp.otherSessions || [];
        for (const s of otherSessions) {
            this.pulledTracks.set(s.sessionId, new Set());
            for (const tName of s.publishedTracks || []) {
                await this._pullTracks(s.sessionId, tName);
            }
        }
        console.log('Joined room', roomId, 'my session:', this.sessionId);

        // 5) Start polling for new tracks
        this._startPolling();
    }

    /**
     * Leaves the current room and cleans up connections.
     * @async
     * @returns {Promise<void>}
     */
    async leaveRoom() {
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        console.log('Left room, closed PC & WS');

        // Stop polling
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }

        // Clear pulledTracks
        this.pulledTracks.clear();
    }

    /************************************************
     * Publish & Pull
     ***********************************************/

    /**
     * Publishes the local media tracks to the room.
     * @async
     * @returns {Promise<void>}
     * @throws {Error} If there is no local media stream to publish.
     */
    async publishTracks() {
        if (!this.localStream) {
            throw new Error('No local media stream to publish.');
        }
        await this._publishTracks();
    }

    /**
     * Unpublishes all local media tracks from the room.
     * @async
     * @returns {Promise<void>}
     */
    async unpublishTracks() {
        if (!this.peerConnection) {
            console.warn('PeerConnection is not established.');
            return;
        }

        const senders = this.peerConnection.getSenders();
        for (const sender of senders) {
            this.peerConnection.removeTrack(sender);
        }

        // Notify the server to remove tracks
        await this._fetch(`${this.backendUrl}/api/rooms/${this.roomId}/sessions/${this.sessionId}/unpublish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        console.log('Unpublished all local tracks.');
    }

    /**
     * Unpublishes a specific local media track (audio or video).
     * @async
     * @param {string} trackKind - The kind of track to unpublish ('audio' or 'video').
     * @param {boolean} [force=false] - If true, forces track closure without renegotiation.
     * @returns {Promise<Object>} Result object from the Cloudflare API.
     * @throws {Error} If PeerConnection is not established or track is not found.
     */
    async unpublishTrack(trackKind, force = false) {
        if (!this.peerConnection) {
            throw new Error('PeerConnection is not established.');
        }

        const sender = this.peerConnection.getSenders().find(s => s.track?.kind === trackKind);
        if (!sender) {
            throw new Error(`No ${trackKind} track found to unpublish.`);
        }

        const transceiver = this.peerConnection.getTransceivers().find(t => t.sender === sender);
        if (!transceiver?.mid) {
            throw new Error('Could not find transceiver mid for track');
        }

        try {
            const unpublishUrl = `${this.backendUrl}/api/rooms/${this.roomId}/sessions/${this.sessionId}/unpublish`;
            const response = await this._fetch(unpublishUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    trackName: sender.track.id,
                    mid: transceiver.mid,
                    force: force
                })
            });

            const result = await response.json();
            this._handleError(result);

            // Stop the track
            sender.track.stop();

            // If not forcing, handle renegotiation
            if (!force && result.requiresImmediateRenegotiation) {
                await this._renegotiate();
            }

            return result;
        } catch (error) {
            console.error(`Error unpublishing ${trackKind} track:`, error);
            throw error;
        }
    }

    /**
     * Initiates renegotiation of the PeerConnection.
     * @async
     * @private
     * @returns {Promise<void>}
     */
    async _renegotiate() {
        if (!this.peerConnection) return;

        if (this._renegotiateTimeout) {
            clearTimeout(this._renegotiateTimeout);
        }

        this._renegotiateTimeout = setTimeout(async () => {
            try {
                console.log('Starting renegotiation process...');
                const answer = await this.peerConnection.createAnswer();
                console.log('Created renegotiation answer:', answer.sdp);
                await this.peerConnection.setLocalDescription(answer);

                const renegotiateUrl = `${this.backendUrl}/api/rooms/${this.roomId}/sessions/${this.sessionId}/renegotiate`;
                const body = { sdp: answer.sdp, type: answer.type };
                console.log(`Sending renegotiate request to ${renegotiateUrl} with body:`, body);

                const response = await this._fetch(renegotiateUrl, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                }).then(r => r.json());

                if (response.errorCode) {
                    console.error('Renegotiation failed:', response.errorDescription);
                    return;
                }

                await this.peerConnection.setRemoteDescription(response.sessionDescription);
                console.log('Renegotiation successful. Applied SFU response.');
            } catch (error) {
                console.error('Error during renegotiation:', error);
            }
        }, 500);
    }

    /**
     * Updates the published media tracks.
     * @async
     * @returns {Promise<void>}
     * @throws {Error} If the PeerConnection is not established.
     */
    async updatePublishedTracks() {
        if (!this.peerConnection) {
            throw new Error('PeerConnection is not established.');
        }

        // Remove existing senders
        const senders = this.peerConnection.getSenders();
        for (const sender of senders) {
            this.peerConnection.removeTrack(sender);
        }

        // Add updated tracks
        await this._publishTracks();
    }

    /**
     * Publishes the local media tracks to the PeerConnection and server.
     * @async
     * @private
     * @returns {Promise<void>}
     */
    async _publishTracks() {
        const transceivers = [];
        for (const track of this.localStream.getTracks()) {
            const tx = this.peerConnection.addTransceiver(track, { direction: 'sendonly' });
            transceivers.push(tx);
        }
        const offer = await this.peerConnection.createOffer();
        console.log('SDP Offer:', offer.sdp);
        await this.peerConnection.setLocalDescription(offer);

        const trackInfos = transceivers.map(({ sender, mid }) => ({
            location: 'local',
            mid,
            trackName: sender.track.id
        }));

        const body = {
            offer: { sdp: offer.sdp, type: offer.type },
            tracks: trackInfos,
            metadata: this.userMetadata
        };
        const publishUrl = `${this.backendUrl}/api/rooms/${this.roomId}/sessions/${this.sessionId}/publish`;
        const resp = await this._fetch(publishUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(r => r.json());

        if (resp.errorCode) {
            console.error('Publish error:', resp.errorDescription);
            return;
        }
        // The SFU's answer
        const answer = resp.sessionDescription;
        await this.peerConnection.setRemoteDescription(answer);
        console.log('Publish => success. Applied SFU answer.');
    }

    /**
     * Pulls a specific track from a remote session.
     * @async
     * @private
     * @param {string} remoteSessionId - The session ID of the remote participant.
     * @param {string} trackName - The name of the track to pull.
     * @returns {Promise<void>}
     */
    async _pullTracks(remoteSessionId, trackName) {
        console.log(`Pulling track '${trackName}' from session ${remoteSessionId}`);
        const pullUrl = `${this.backendUrl}/api/rooms/${this.roomId}/sessions/${this.sessionId}/pull`;
        const body = { remoteSessionId, trackName };

        const resp = await this._fetch(pullUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(r => r.json());

        if (resp.errorCode) {
            console.error('Pull error:', resp.errorDescription);
            return;
        }

        if (resp.requiresImmediateRenegotiation) {
            console.log('Pull => requires renegotiation');
            
            // Set up both mappings from the SDP
            const pendingMids = new Set();
            resp.sessionDescription.sdp.split('\n').forEach(line => {
                if (line.startsWith('a=mid:')) {
                    const mid = line.split(':')[1].trim();
                    pendingMids.add(mid);
                    this.midToSessionId.set(mid, remoteSessionId);
                    this.midToTrackName.set(mid, trackName);
                    console.log('Pre-mapped MID:', {
                        mid,
                        sessionId: remoteSessionId,
                        trackName
                    });
                }
            });

            // Now set the remote description
            await this.peerConnection.setRemoteDescription(resp.sessionDescription);
            
            // Create and set local answer
            const localAnswer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(localAnswer);

            // Verify mappings are still correct
            const transceivers = this.peerConnection.getTransceivers();
            transceivers.forEach(transceiver => {
                if (transceiver.mid && pendingMids.has(transceiver.mid)) {
                    console.log('Verified MID mapping:', {
                        mid: transceiver.mid,
                        sessionId: remoteSessionId,
                        direction: transceiver.direction
                    });
                }
            });

            await this._fetch(`${this.backendUrl}/api/rooms/${this.roomId}/sessions/${this.sessionId}/renegotiate`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sdp: localAnswer.sdp, type: localAnswer.type })
            });
        }

        console.log(`Pulled trackName="${trackName}" from session ${remoteSessionId}`);
        console.log('Current MID mappings:', Array.from(this.midToSessionId.entries()));

        // Record the pulled track
        if (!this.pulledTracks.has(remoteSessionId)) {
            this.pulledTracks.set(remoteSessionId, new Set());
        }
        this.pulledTracks.get(remoteSessionId).add(trackName);
    }

    /************************************************
     * PeerConnection & WebSocket
     ***********************************************/

    /**
     * Creates and configures a new RTCPeerConnection.
     * @async
     * @private
     * @returns {Promise<RTCPeerConnection>} The configured RTCPeerConnection instance.
     */
    async _createPeerConnection() {
        let iceServers = [
            { urls: 'stun:stun.cloudflare.com:3478' }
        ];

        try {
            const response = await this._fetch(`${this.backendUrl}/api/ice-servers`);
            if (!response.ok) {
                throw new Error(`Failed to fetch ICE servers: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();

            // Validate and process the fetched ICE servers
            if (data.iceServers && Array.isArray(data.iceServers)) {
                iceServers = data.iceServers.map(server => {
                    // Ensure each server has the required fields
                    const iceServer = { urls: server.urls };
                    if (server.username && server.credential) {
                        iceServer.username = server.username;
                        iceServer.credential = server.credential;
                    }
                    return iceServer;
                });
                console.log('Fetched ICE servers:', iceServers);
            } else {
                throw new Error('Invalid ICE servers format received from /api/ice-servers');
            }
        } catch (error) {
            console.error('Error fetching ICE servers:', error);
            // Fallback to default ICE servers if fetching fails
            iceServers = [
                { urls: 'stun:stun.cloudflare.com:3478' },
            ];
        }

        const pc = new RTCPeerConnection({
            iceServers: iceServers,
            bundlePolicy: 'max-bundle',
            sdpSemantics: 'unified-plan'
        });

        pc.onicecandidate = (evt) => {
            if (evt.candidate) {
                console.log('New ICE candidate:', evt.candidate.candidate);
            } else {
                console.log('All ICE candidates have been sent');
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log('ICE Connection State:', pc.iceConnectionState);
            if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                this.leaveRoom();
            }
        };

        pc.onconnectionstatechange = () => {
            console.log('Connection State:', pc.connectionState);
            if (pc.connectionState === 'connected') {
                console.log('Peer connection fully established');
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                console.log('Peer connection disconnected or failed');
                this.leaveRoom();
            }
        };

        pc.ontrack = (evt) => {
            console.log('ontrack event:', {
                kind: evt.track.kind,
                webrtcTrackId: evt.track.id,
                mid: evt.transceiver?.mid
            });

            if (this._onRemoteTrackCallback) {
                const mid = evt.transceiver?.mid;
                const sessionId = this.midToSessionId.get(mid);
                const trackName = this.midToTrackName.get(mid);

                console.log('Track mapping lookup:', {
                    mid,
                    sessionId,
                    trackName,
                    webrtcTrackId: evt.track.id,
                    availableMappings: {
                        sessions: Array.from(this.midToSessionId.entries()),
                        tracks: Array.from(this.midToTrackName.entries())
                    }
                });

                if (!sessionId) {
                    console.warn('No sessionId found for mid:', mid);
                    if (!this.pendingTracks) this.pendingTracks = [];
                    this.pendingTracks.push({ evt, mid });
                    return;
                }

                const wrappedTrack = evt.track;
                wrappedTrack.sessionId = sessionId;
                wrappedTrack.mid = mid;
                wrappedTrack.trackName = trackName;

                console.log('Sending track to callback:', {
                    webrtcTrackId: wrappedTrack.id,
                    trackName: wrappedTrack.trackName,
                    sessionId: wrappedTrack.sessionId,
                    mid: wrappedTrack.mid
                });

                this._onRemoteTrackCallback(wrappedTrack);
            }
        };

        return pc;
    }

    /**
     * Initializes the WebSocket connection.
     * @async
     * @private
     * @returns {Promise<void>}
     */
    async _initWebSocket() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.websocketUrl);
            this.ws.onopen = () => {
                console.log('WebSocket open');
                this.ws.send(JSON.stringify({
                    type: 'join-websocket',
                    payload: { roomId: this.roomId, userId: this.userId, token: this.token }
                }));
                resolve();
            };
            this.ws.onmessage = async (evt) => {
                console.log('WebSocket message received:', evt.data);
                const data = JSON.parse(evt.data);
                
                switch (data.type) {
                    case 'track-unpublished':
                        console.log('Track unpublished event received:', data.payload);
                        if (this._onRemoteTrackUnpublishedCallback) {
                            this._onRemoteTrackUnpublishedCallback(data.payload.sessionId, data.payload.trackName);
                        }
                        break;
                    // ... other cases ...
                }
            };
            this.ws.onerror = (err) => {
                console.error('WebSocket error:', err);
                reject(err);
            };
            this.ws.onclose = () => {
                console.log('WebSocket closed');
            };
        });
    }

    /************************************************
     * Polling for New Tracks
     ***********************************************/

    /**
     * Starts polling the server for new tracks every 10 seconds.
     * @private
     * @returns {void}
     */
    _startPolling() {
        this.pollingInterval = setInterval(async () => {
            try {
                const resp = await this._fetch(`${this.backendUrl}/api/rooms/${this.roomId}/participants`)
                    .then(r => r.json());
                const participants = resp.participants || [];

                for (const participant of participants) {
                    const { sessionId, publishedTracks } = participant;
                    if (sessionId === this.sessionId) continue; // Skip self

                    if (!this.pulledTracks.has(sessionId)) {
                        this.pulledTracks.set(sessionId, new Set());
                    }

                    for (const trackName of publishedTracks) {
                        if (!this.pulledTracks.get(sessionId).has(trackName)) {
                            console.log(`[Polling] New track detected: ${trackName} from session ${sessionId}`);
                            await this._pullTracks(sessionId, trackName);
                        }
                    }
                }
            } catch (err) {
                console.error('Polling error:', err);
            }
        }, 10000);
    }

    /**
     * Removes all media elements associated with a participant.
     * @private
     * @param {string} sessionId - The session ID of the participant to remove.
     * @returns {void}
     */
    _removeParticipantTracks(sessionId) {
        // Just notify via callback
        if (this._onParticipantLeftCallback) {
            this._onParticipantLeftCallback(sessionId);
        }
    }

    /**
     * Removes a specific remote media track from the DOM.
     * @private
     * @param {string} sessionId - The session ID of the remote participant.
     * @param {string} trackName - The name/ID of the track to remove.
     */
    _removeRemoteTrack(sessionId, trackName) {
        if (this._onRemoteTrackUnpublishedCallback) {
            this._onRemoteTrackUnpublishedCallback(sessionId, trackName);
        }
    }

    /************************************************
     * Device Management
     ***********************************************/

    /**
     * Retrieves the list of available media devices.
     * @async
     * @returns {Promise<Object>} An object containing arrays of audio input, video input, and audio output devices.
     */
    async getAvailableDevices() {
        const devices = await navigator.mediaDevices.enumerateDevices();
        this.availableAudioInputDevices = devices.filter(device => device.kind === 'audioinput');
        this.availableVideoInputDevices = devices.filter(device => device.kind === 'videoinput');
        this.availableAudioOutputDevices = devices.filter(device => device.kind === 'audiooutput');

        return {
            audioInput: this.availableAudioInputDevices,
            videoInput: this.availableVideoInputDevices,
            audioOutput: this.availableAudioOutputDevices
        };
    }

    /**
     * Selects a specific audio input device.
     * @async
     * @param {string} deviceId - The ID of the audio input device to select.
     * @returns {Promise<void>}
     */
    async selectAudioInputDevice(deviceId) {
        if (!deviceId) {
            console.warn('No deviceId provided for audio input.');
            return;
        }

        const constraints = {
            audio: { deviceId: { exact: deviceId } },
            video: false
        };

        try {
            const newStream = await navigator.mediaDevices.getUserMedia(constraints);
            const newAudioTrack = newStream.getAudioTracks()[0];
            const sender = this.peerConnection.getSenders().find(s => s.track.kind === 'audio');
            if (sender) {
                sender.replaceTrack(newAudioTrack);
                const oldTrack = sender.track;
                oldTrack.stop();
            } else {
                this.localStream.addTrack(newAudioTrack);
                await this._publishTracks();
            }

            console.log(`Switched to audio input device: ${deviceId}`);
        } catch (error) {
            console.error('Error switching audio input device:', error);
        }
    }

    /**
     * Selects a specific video input device.
     * @async
     * @param {string} deviceId - The ID of the video input device to select.
     * @returns {Promise<void>}
     */
    async selectVideoInputDevice(deviceId) {
        if (!deviceId) {
            console.warn('No deviceId provided for video input.');
            return;
        }

        const constraints = {
            video: { deviceId: { exact: deviceId } },
            audio: false
        };

        try {
            const newStream = await navigator.mediaDevices.getUserMedia(constraints);
            const newVideoTrack = newStream.getVideoTracks()[0];
            const sender = this.peerConnection.getSenders().find(s => s.track.kind === 'video');
            if (sender) {
                sender.replaceTrack(newVideoTrack);
                const oldTrack = sender.track;
                oldTrack.stop();
            } else {
                this.localStream.addTrack(newVideoTrack);
                await this._publishTracks();
            }

            console.log(`Switched to video input device: ${deviceId}`);
        } catch (error) {
            console.error('Error switching video input device:', error);
        }
    }

    /**
     * Selects a specific audio output device.
     * @async
     * @param {string} deviceId - The ID of the audio output device to select.
     * @returns {Promise<void>}
     */
    async selectAudioOutputDevice(deviceId) {
        if (!deviceId) {
            console.warn('No deviceId provided for audio output.');
            return;
        }

        try {
            const audioElements = document.querySelectorAll('audio');
            for (const audio of audioElements) {
                await audio.setSinkId(deviceId);
            }
            this.currentAudioOutputDeviceId = deviceId;
            console.log(`Switched to audio output device: ${deviceId}`);
        } catch (error) {
            console.error('Error switching audio output device:', error);
        }
    }

    /**
     * Sets the audio output device for a specific media element.
     * @async
     * @param {HTMLMediaElement} mediaElement - The media element to set the output device for.
     * @param {string} deviceId - The ID of the audio output device to set.
     * @returns {Promise<void>}
     */
    async setAudioOutputDevice(mediaElement, deviceId) {
        if (!deviceId) {
            console.warn('No deviceId provided for audio output.');
            return;
        }

        try {
            await mediaElement.setSinkId(deviceId);
            console.log(`Set audio output device for media element to: ${deviceId}`);
        } catch (error) {
            console.error('Error setting audio output device:', error);
        }
    }

    /**
     * Retrieves the current audio output device ID.
     * @returns {string|null} The current audio output device ID, or null if not set.
     */
    getCurrentAudioOutputDeviceId() {
        return this.currentAudioOutputDeviceId;
    }

    /**
     * Previews media streams with specified device IDs.
     * @async
     * @param {Object} params - Parameters for media preview.
     * @param {string} [params.audioDeviceId] - The ID of the audio input device to use.
     * @param {string} [params.videoDeviceId] - The ID of the video input device to use.
     * @param {HTMLMediaElement} [previewElement=null] - The media element to display the preview.
     * @returns {Promise<MediaStream>} The media stream being previewed.
     * @throws {Error} If there is an issue accessing the media devices.
     */
    async previewMedia({ audioDeviceId, videoDeviceId }, previewElement = null) {
        const constraints = {
            audio: audioDeviceId ? { deviceId: { exact: audioDeviceId } } : false,
            video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : false
        };

        try {
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            if (previewElement) {
                previewElement.srcObject = stream;
            }
            return stream;
        } catch (error) {
            console.error('Error previewing media:', error);
            throw error;
        }
    }

    /************************************************
     * Media Controls
     ***********************************************/

    /**
     * Toggles the enabled state of video and/or audio tracks.
     * @param {Object} options - Options to toggle media tracks.
     * @param {boolean} [options.video=null] - Whether to toggle video tracks.
     * @param {boolean} [options.audio=null] - Whether to toggle audio tracks.
     * @returns {void}
     */
    toggleMedia({ video = null, audio = null }) {
        if (!this.localStream) return;

        if (video !== null) {
            const videoTracks = this.localStream.getVideoTracks();
            videoTracks.forEach(track => {
                track.enabled = video;
                // Find the corresponding sender and update the track status
                const sender = this.peerConnection?.getSenders().find(s => s.track === track);
                if (sender) {
                    // Send track status update to SFU
                    this._updateTrackStatus(sender.track.id, 'video', video);
                }
            });
        }

        if (audio !== null) {
            const audioTracks = this.localStream.getAudioTracks();
            audioTracks.forEach(track => {
                track.enabled = audio;
                // Find the corresponding sender and update the track status
                const sender = this.peerConnection?.getSenders().find(s => s.track === track);
                if (sender) {
                    // Send track status update to SFU
                    this._updateTrackStatus(sender.track.id, 'audio', audio);
                }
            });
        }
    }

    /**
     * Initiates screen sharing by adding a screen video track to the PeerConnection.
     * @async
     * @returns {Promise<void>}
     */
    async shareScreen() {
        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const screenTrack = screenStream.getVideoTracks()[0];

            // Add the screen track to the peer connection
            const screenTransceiver = this.peerConnection.addTransceiver(screenTrack, { direction: 'sendonly' });

            screenTrack.label = 'screen';

            // Update server about the new track
            const offer = await this.peerConnection.createOffer();
            console.log('SDP Offer:', offer.sdp);
            await this.peerConnection.setLocalDescription(offer);

            const trackInfo = {
                location: 'local',
                mid: screenTransceiver.mid,
                trackName: screenTrack.id,
                label: 'screen'
            };

            const body = {
                offer: { sdp: offer.sdp, type: offer.type },
                tracks: [trackInfo]
            };
            const publishUrl = `${this.backendUrl}/api/rooms/${this.roomId}/sessions/${this.sessionId}/publish`;
            const resp = await this._fetch(publishUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }).then(r => r.json());

            if (resp.errorCode) {
                console.error('Screen share publish error:', resp.errorDescription);
                return;
            }

            const answer = resp.sessionDescription;
            await this.peerConnection.setRemoteDescription(answer);
            console.log('Screen share => success. Applied SFU answer.');

            // When user stops sharing
            screenTrack.onended = () => {
                this._stopScreenShare(screenTransceiver);
            };
        } catch (error) {
            console.error('Error sharing screen:', error);
        }
    }

    /**
     * Stops screen sharing by removing the screen video track from the PeerConnection.
     * @async
     * @private
     * @param {RTCRtpTransceiver} transceiver - The transceiver associated with the screen track.
     * @returns {Promise<void>}
     */
    async _stopScreenShare(transceiver) {
        if (!transceiver) return;

        transceiver.stop();
        const screenTrack = transceiver.sender.track;
        screenTrack.stop();

        // Notify server to remove that track
        await this._fetch(`${this.backendUrl}/api/rooms/${this.roomId}/sessions/${this.sessionId}/unpublish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trackName: screenTrack.id })
        });

        console.log('Screen sharing stopped and track unpublished.');
    }

    /************************************************
     * WebSocket-Based Data Communication
     ***********************************************/

    /**
     * Send a data message to all participants in the room via WebSocket.
     * @param {Object} message - The JSON object to send.
     * @returns {void}
     */
    sendDataToAll(message) {
        const data = {
            type: 'data-message',
            payload: {
                from: this.userId,
                to: 'all', // Special identifier for broadcasting
                message
            }
        };
        this._sendWebSocketMessage(data);
    }

    /**
     * Send a data message to a specific participant via WebSocket.
     * @param {string} participantId - The userId of the target participant.
     * @param {Object} message - The JSON object to send.
     * @returns {void}
     */
    sendDataToParticipant(participantId, message) {
        const data = {
            type: 'data-message',
            payload: {
                from: this.userId,
                to: participantId, // Target participant's userId
                message
            }
        };
        this._sendWebSocketMessage(data);
    }

    /**
     * Internal method to send a message via WebSocket.
     * @private
     * @param {Object} data - The data object to send.
     * @returns {void}
     */
    _sendWebSocketMessage(data) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('WebSocket is not open. Cannot send message.');
            return;
        }
        this.ws.send(JSON.stringify(data));
        console.log('Sent WebSocket message:', data);
    }

    /************************************************
     * Participant Management
     ***********************************************/

    /**
     * Lists all participants currently in the room.
     * @async
     * @returns {Promise<Array<Object>>} An array of participant objects.
     * @throws {Error} If not connected to any room.
     */
    async listParticipants() {
        if (!this.roomId) {
            throw new Error('Not connected to any room.');
        }

        const resp = await this._fetch(`${this.backendUrl}/api/rooms/${this.roomId}/participants`)
            .then(r => r.json());

        return resp.participants || [];
    }

    /************************************************
     * Helpers & Placeholders
     ***********************************************/

    /**
     * Generates a simple UUID.
     * @private
     * @returns {string} A generated UUID string.
     */
    _generateUUID() {
        // Simple placeholder generator
        return 'xxxx-xxxx-xxxx-xxxx'.replace(/[x]/g, () =>
            ((Math.random() * 16) | 0).toString(16)
        );
    }

    /**
     * Sends a POST request to a specified API path with a JSON body.
     * @async
     * @param {string} apiPath - The API path to send the request to.
     * @param {Object} body - The JSON body to include in the request.
     * @returns {Promise<Object>} The JSON response from the server.
     */
    async sendRequest(apiPath, body) {
        const response = await this._fetch(`${this.backendUrl}${apiPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return response.json();
    }

    /**
     * Checks for errors in the result object and throws an error if any are found.
     * @param {Object} result - The result object to check for errors.
     * @throws {Error} If an error code is present in the result.
     * @returns {void}
     */
    checkErrors(result) {
        if (result.errorCode) {
            throw new Error(result.errorDescription || 'Unknown error');
        }
    }

    /**
     * Handles incoming data messages from WebSocket.
     * @param {MessageEvent} evt - The WebSocket message event.
     * @returns {void}
     */
    handleIncomingData(evt) {
        console.log('Received message:', evt.data);
    }

    /**
     * Unpublishes all currently published tracks
     * @async
     * @returns {Promise<void>}
     */
    async unpublishAllTracks() {
        if (!this.peerConnection) {
            console.warn('PeerConnection is not established.');
            return;
        }

        const senders = this.peerConnection.getSenders();
        console.log('Unpublishing all tracks:', senders.length);
        
        for (const sender of senders) {
            if (sender.track) {
                try {
                    const trackId = sender.track.id;
                    const transceiver = this.peerConnection.getTransceivers().find(t => t.sender === sender);
                    const mid = transceiver ? transceiver.mid : null;
                    
                    console.log('Unpublishing track:', { trackId, mid });
                    
                    if (!mid) {
                        console.warn('No mid found for track:', trackId);
                        continue;
                    }

                    // Stop the track first
                    sender.track.stop();
                    
                    // Notify server
                    await this._fetch(`${this.backendUrl}/api/rooms/${this.roomId}/sessions/${this.sessionId}/unpublish`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            trackName: trackId,
                            mid: mid
                        })
                    });

                    // Remove from PeerConnection after server confirms
                    this.peerConnection.removeTrack(sender);
                    
                    // Remove from our tracked set
                    this.publishedTracks.delete(trackId);
                    
                    console.log(`Successfully unpublished track: ${trackId}`);
                } catch (error) {
                    console.error(`Error unpublishing track:`, error);
                }
            }
        }
    }

    /**
     * Handles track unpublished events from other peers
     * @private
     * @param {string} sessionId - The session ID of the peer
     * @param {string} trackName - The track name/ID
     */
    _handleTrackUnpublished(sessionId, trackName) {
        console.log('Track unpublished event received:', { sessionId, trackName });

        // Find elements by session ID and track name
        const mediaElements = document.querySelectorAll(
            `[data-session-id="${sessionId}"]`
        );

        mediaElements.forEach(element => {
            const mid = element.getAttribute('data-mid');
            const storedTrackName = this.midToTrackName.get(mid);
            
            if (storedTrackName === trackName) {
                if (element.srcObject) {
                    element.srcObject.getTracks().forEach(track => track.stop());
                }
                console.log('Removing element:', {
                    sessionId: element.dataset.sessionId,
                    trackName: storedTrackName,
                    mid
                });
                element.remove();
            }
        });

        // Clean up our mappings
        for (const [mid, name] of this.midToTrackName.entries()) {
            if (name === trackName) {
                this.midToTrackName.delete(mid);
                this.midToSessionId.delete(mid);
            }
        }
    }

    /**
     * Creates a media element for a track
     * @private
     * @param {MediaStreamTrack} track - The media track
     * @param {string} sessionId - The session ID of the peer
     * @returns {HTMLElement} The created media element
     */
    _createMediaElement(track, sessionId) {
        const element = document.createElement(track.kind === 'video' ? 'video' : 'audio');
        element.autoplay = true;
        if (track.kind === 'video') {
            element.playsInline = true;
        }
        
        // Add data attributes for easier cleanup
        element.dataset.sessionId = sessionId;
        element.dataset.trackId = track.id;
        
        const stream = new MediaStream([track]);
        element.srcObject = stream;
        
        return element;
    }

    /**
     * Gets the session state
     * @async
     * @returns {Promise<Object>} The session state
     */
    async getSessionState() {
        if (!this.sessionId) {
            throw new Error('No active session');
        }

        try {
            const response = await this._fetch(`${this.backendUrl}/api/rooms/${this.roomId}/sessions/${this.sessionId}/state`);
            const state = await response.json();
            
            // Store track states internally
            if (state.tracks) {
                this.trackStates = new Map(
                    state.tracks.map(track => [track.trackName, track.status])
                );
            }
            
            return state;
        } catch (error) {
            console.error('Error getting session state:', error);
            throw error;
        }
    }

    /**
     * Gets the track status
     * @async
     * @param {string} trackName - The track name
     * @returns {Promise<string>} The track status
     */
    async getTrackStatus(trackName) {
        const state = await this.getSessionState();
        return state.tracks.find(t => t.trackName === trackName)?.status;
    }

    /**
     * Updates the track status
     * @async
     * @param {string} trackId - The track ID
     * @param {string} kind - The track kind
     * @param {boolean} enabled - Whether the track is enabled
     * @returns {Promise<Object>} The updated track status
     */
    async _updateTrackStatus(trackId, kind, enabled) {
        try {
            const updateUrl = `${this.backendUrl}/api/rooms/${this.roomId}/sessions/${this.sessionId}/track-status`;
            const response = await this._fetch(updateUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    trackId,
                    kind,
                    enabled,
                    force: false // Allow proper renegotiation
                })
            });

            const result = await response.json();
            if (result.errorCode) {
                throw new Error(result.errorDescription || 'Unknown error updating track status');
            }

            // If renegotiation is needed, handle it
            if (result.requiresImmediateRenegotiation) {
                await this._renegotiate();
            }

            return result;
        } catch (error) {
            console.error(`Error updating track status:`, error);
            throw error;
        }
    }

    /**
     * Handles errors
     * @private
     * @param {Object} response - The response object
     * @returns {Object} The response object
     */
    _handleError(response) {
        if (response.errorCode) {
            const error = new Error(response.errorDescription || 'Unknown error');
            error.code = response.errorCode;
            throw error;
        }
        return response;
    }

    /**
     * Gets information about a user
     * @async
     * @param {string} [userId] - Optional user ID. If omitted, returns current user's info
     * @returns {Promise<Object>} User information including moderator status
     */
    async getUserInfo(userId = null) {
        try {
            const response = await this._fetch(
                `${this.backendUrl}/api/users/${userId || 'me'}`
            );
            return await response.json();
        } catch (error) {
            console.error('Error getting user info:', error);
            throw error;
        }
    }
}

export default CloudflareCalls;
