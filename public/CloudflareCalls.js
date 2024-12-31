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
     * @typedef {Object} VideoQualitySettings
     * @property {Object} width - Video width settings
     * @property {number} width.ideal - Ideal video width in pixels
     * @property {Object} height - Video height settings
     * @property {number} height.ideal - Ideal video height in pixels
     * @property {Object} frameRate - Frame rate settings
     * @property {number} frameRate.ideal - Ideal frame rate in fps
     * @property {number} maxBitrate - Maximum video bitrate in bps
     */

    /**
     * @typedef {Object} AudioQualitySettings
     * @property {number} maxBitrate - Maximum audio bitrate in bps
     * @property {number} sampleRate - Audio sample rate in Hz
     * @property {number} channelCount - Number of audio channels (1=mono, 2=stereo)
     */

    /**
     * @typedef {Object} QualityPreset
     * @property {VideoQualitySettings} video - Video quality settings
     * @property {AudioQualitySettings} audio - Audio quality settings
     */

    /**
     * @typedef {Object} ConnectionStats
     * @property {Object} outbound - Outbound (sending) statistics
     * @property {number} outbound.bitrate - Current outbound bitrate in bits/s
     * @property {number} outbound.packetLoss - Percentage of packets lost
     * @property {string} outbound.qualityLimitation - Reason for quality limitations (if any)
     * @property {Object} inbound - Inbound (receiving) statistics per track
     * @property {number} inbound.bitrate - Current inbound bitrate in bits/s
     * @property {number} inbound.packetLoss - Percentage of packets lost
     * @property {number} inbound.jitter - Current jitter in seconds
     * @property {Object} connection - Overall connection statistics
     * @property {number} connection.roundTripTime - Current round trip time in seconds
     * @property {string} connection.state - Current connection state
     */

    /**
     * @typedef {Object} StreamStats
     * @property {string} sessionId - Session ID of the stream
     * @property {number} packetLoss - Packet loss percentage
     * @property {string} qualityLimitation - Quality limitation reason
     * @property {number} bitrate - Current bitrate
     */

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

        this.userMetadata = {};

        this.localStream = null;
        this.peerConnection = null;
        this.ws = null;

        // Specific message handlers
        this._onParticipantJoinedCallback = null;
        this._onParticipantLeftCallback = null;
        this._onRemoteTrackCallback = null;
        this._onRemoteTrackUnpublishedCallback = null;
        this._onTrackStatusChangedCallback = null;
        this._onDataMessageCallback = null;
        this._onConnectionStatsCallback = null;
        
        // Generic message handlers
        this._wsMessageHandlers = new Set();

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

        this._onRoomMetadataUpdatedCallback = null;

        // Store initial quality settings
        /** @type {QualityPreset} */
        this.pendingQualitySettings = null;
        
        this.mediaQuality = CloudflareCalls.QUALITY_PRESETS.medium_16x9_md;

        /** @type {Object.<string, QualityPreset>} */
        this.QUALITY_PRESETS = CloudflareCalls.QUALITY_PRESETS;

        // Stats monitoring
        this.statsInterval = null;
        this.previousStats = null;
        
        /** @type {'stopped'|'monitoring'} */
        this.statsMonitoringState = 'stopped';
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

    /**
     * Registers a callback for WebSocket messages
     * @param {Function} callback - Function to call when WebSocket messages are received
     * @returns {Function} Function to unregister the callback
     */
    onWebSocketMessage(callback) {
        this._wsMessageHandlers.add(callback);
        return () => this._wsMessageHandlers.delete(callback);
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
     * Register callback for room metadata updates
     * @param {Function} callback Callback function
     */
    onRoomMetadataUpdated(callback) {
        this._onRoomMetadataUpdatedCallback = callback;
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
     * Updates user metadata on the server
     * @private
     * @async
     * @returns {Promise<void>}
     */
    async _updateUserMetadataOnServer() {
        if (!this.roomId || !this.sessionId) {
            console.warn('Cannot update metadata before joining a room.');
            return;
        }

        try {
            const updateUrl = `${this.backendUrl}/api/rooms/${this.roomId}/metadata`;
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
            throw error;
        }
    }

    /************************************************
     * Room & Session Management
     ***********************************************/

    /**
     * Creates a new room with optional metadata.
     * @async
     * @param {Object} options Room creation options
     * @param {string} [options.name] Room name
     * @param {Object} [options.metadata] Room metadata
     * @returns {Promise<Object>} Created room information including roomId, name, metadata, etc.
     */
    async createRoom(options = {}) {
        const resp = await this._fetch(`${this.backendUrl}/api/rooms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(options)
        }).then(r => r.json());
        
        // Store the roomId
        this.roomId = resp.roomId;
        
        // Return the full room object
        return resp;
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

        // 1) Ask server to create a CF Calls session
        const joinResp = await this._fetch(`${this.backendUrl}/api/rooms/${roomId}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: this.userId, metadata: this.userMetadata })
        }).then(r => r.json());

        await this._initWebSocket();

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

        this.setUserMetadata(metadata);

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
        if (!this.localStream || !this.peerConnection) return;

        const transceivers = [];
        for (const track of this.localStream.getTracks()) {
            // Check if we've already published this track
            if (this.publishedTracks.has(track.id)) continue;
            if (track.readyState !== 'live') continue;
            
            const tx = this.peerConnection.addTransceiver(track, { direction: 'sendonly' });
            
            // Apply any pending quality settings to video tracks
            if (this.pendingQualitySettings && track.kind === 'video') {
                const params = tx.sender.getParameters();
                params.encodings = [{
                    maxBitrate: this.pendingQualitySettings.video.maxBitrate
                }];
                tx.sender.setParameters(params);
            }
            
            transceivers.push(tx);
            this.publishedTracks.add(track.id);
        }

        if (transceivers.length === 0) return;  // No new tracks to publish

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
                    payload: { 
                        roomId: this.roomId, 
                        userId: this.userId, 
                        token: this.token 
                    }
                }));
                resolve();
            };

            this.ws.onmessage = this._handleWebSocketMessage.bind(this);
            
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
     * Starts screen sharing.
     * @async
     * @returns {Promise<void>}
     */
    async shareScreen() {
        try {
            // Stop any existing video tracks (Todo: breaks the addTrack)
            // await this.unpublishAllTracks('video');

            const screenStream = await navigator.mediaDevices.getDisplayMedia({ 
                video: true,
                audio: false  // Most browsers don't support screen audio yet
            });

            const screenTrack = screenStream.getVideoTracks()[0];
            
            // Add the new screen track
            this.localStream.addTrack(screenTrack);

            // Publish the new track
            await this._publishTracks();

            // Handle the user stopping screen share
            screenTrack.onended = async () => {
                this.localStream.removeTrack(screenTrack);
                // Get a new video track from the camera
                const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
                this.localStream.addTrack(newStream.getVideoTracks()[0]);
                await this._publishTracks();
            };
        } catch (err) {
            console.error('Error sharing screen:', err);
            throw err;
        }
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
     * Unpublishes all currently published tracks
     * @async
     * @returns {Promise<void>}
     */
    async unpublishAllTracks(trackKind) {
        if (!this.peerConnection) {
            console.warn('PeerConnection is not established.');
            return;
        }

        let senders = this.peerConnection.getSenders();
        if (trackKind) {
            senders = senders.filter(s => s.track && s.track.kind === trackKind);
        }
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
     * @private
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

            if (!result.errorCode) {
                this._updateTrackState(trackId, enabled ? 'enabled' : 'disabled');
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

    /**
     * Handles WebSocket messages
     * @private
     * @param {MessageEvent} event - The WebSocket message event
     * @returns {void}
     */
    _handleWebSocketMessage(event) {
        try {
            const message = JSON.parse(event.data);
            console.log('WebSocket message received:', message);

            // First, notify generic handlers
            this._wsMessageHandlers.forEach(handler => {
                try {
                    handler(message);
                } catch (err) {
                    console.error('Error in WebSocket message handler:', err);
                }
            });

            // Then handle specific message types
            switch (message.type) {
                case 'participant-joined':
                    if (this._onParticipantJoinedCallback) {
                        this._onParticipantJoinedCallback(message.payload);
                    }
                    break;

                case 'participant-left':
                    if (this._onParticipantLeftCallback) {
                        this._onParticipantLeftCallback(message.payload.sessionId);
                    }
                    break;

                case 'track-published':
                    if (this._onRemoteTrackCallback) {
                        // Handle track published event
                        this._onRemoteTrackCallback(message.payload);
                    }
                    break;

                case 'track-unpublished':
                    if (this._onRemoteTrackUnpublishedCallback) {
                        this._onRemoteTrackUnpublishedCallback(
                            message.payload.sessionId,
                            message.payload.trackName
                        );
                    }
                    break;

                case 'track-status-changed':
                    if (this._onTrackStatusChangedCallback) {
                        this._onTrackStatusChangedCallback(message.payload);
                    }
                    break;

                case 'data-message':
                    if (this._onDataMessageCallback) {
                        this._onDataMessageCallback(message.payload);
                    }
                    break;

                case 'room-metadata-updated':
                    if (this._onRoomMetadataUpdatedCallback) {
                        this._onRoomMetadataUpdatedCallback(message.payload);
                    }
                    break;

                default:
                    console.log('Unhandled message type:', message.type);
            }
        } catch (error) {
            console.error('Error handling WebSocket message:', error);
        }
    }

    /**
     * Updates track state in internal tracking
     * @private
     * @param {string} trackName - The track name
     * @param {string} status - The new status
     */
    _updateTrackState(trackName, status) {
        if (!this.trackStates) {
            this.trackStates = new Map();
        }
        this.trackStates.set(trackName, status);
    }

    /**
     * Lists all available rooms.
     * @async
     * @returns {Promise<Array>} List of rooms
     */
    async listRooms() {
        const resp = await this._fetch(`${this.backendUrl}/api/rooms`)
            .then(r => r.json());
        return resp.rooms;
    }

    /**
     * Updates room metadata.
     * @async
     * @param {Object} updates Metadata updates
     * @param {string} [updates.name] New room name
     * @param {Object} [updates.metadata] New room metadata
     * @returns {Promise<Object>} Updated room information
     */
    async updateRoomMetadata(updates) {
        if (!this.roomId) {
            throw new Error('Not connected to any room');
        }

        return await this._fetch(`${this.backendUrl}/api/rooms/${this.roomId}/metadata`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        }).then(r => r.json());
    }

    /**
     * Sends a data message to all participants in the current room
     * @async
     * @param {*} data - The data to send
     */
    async sendDataToAll(data) {
        if (!this.roomId || !this.sessionId) {
            throw new Error('Must be in a room to send data');
        }

        // Send via WebSocket instead of HTTP
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'data-message',
                payload: {
                    from: this.sessionId,
                    message: data
                }
            }));
        } else {
            throw new Error('WebSocket connection not available');
        }
    }

    /**
     * Sets the media quality for audio and video tracks
     * @param {string|QualityPreset} quality - Either a preset name ('high', 'medium', 'low') or a custom quality object
     * @param {VideoQualitySettings} [quality.video] - Video quality settings
     * @param {AudioQualitySettings} [quality.audio] - Audio quality settings
     * @throws {Error} If preset name is invalid
     */
    setMediaQuality(quality) {
        // If quality is a string, use the preset
        if (typeof quality === 'string') {
            const preset = CloudflareCalls.QUALITY_PRESETS[quality];
            if (!preset) {
                throw new Error(`Unknown quality preset: ${quality}`);
            }
            this.mediaQuality = quality;
            quality = preset;
        }

        this.mediaQuality = {
            video: { ...this.mediaQuality.video, ...quality.video },
            audio: { ...this.mediaQuality.audio, ...quality.audio }
        };

        // Store settings to apply to future tracks
        this.pendingQualitySettings = this.mediaQuality;

        // If we're already in a call, update existing tracks
        if (this.peerConnection) {
            this._applyQualitySettings();
        }
    }

    /**
     * Applies quality settings to all tracks
     * @private
     */
    async _applyQualitySettings() {
        if (!this.peerConnection) return;

        const senders = this.peerConnection.getSenders();
        for (const sender of senders) {
            if (!sender.track) continue;

            const params = sender.getParameters();
            if (!params.encodings) {
                params.encodings = [{}];
            }

            const kind = sender.track.kind;
            const qualitySettings = this.mediaQuality[kind];

            // Update bitrate
            if (qualitySettings.maxBitrate) {
                params.encodings[0].maxBitrate = qualitySettings.maxBitrate;
            }

            // Update resolution/framerate for video
            if (kind === 'video') {
                const constraints = {
                    width: qualitySettings.width,
                    height: qualitySettings.height,
                    frameRate: qualitySettings.frameRate
                };
                await sender.track.applyConstraints(constraints);
            }

            await sender.setParameters(params);
        }
    }

    /**
     * Start monitoring connection statistics
     * @param {number} [interval=1000] - How often to gather stats in milliseconds
     */
    startStatsMonitoring(interval = 1000) {
        if (this.statsMonitoringState === 'monitoring') return;
        
        this.statsMonitoringState = 'monitoring';
        this.statsInterval = setInterval(async () => {
            if (!this.peerConnection) return;
            
            const stats = await this._gatherConnectionStats();
            const streamStats = await this._gatherStreamStats();
            
            if (this._onConnectionStatsCallback) {
                this._onConnectionStatsCallback(stats, streamStats);
            }
        }, interval);
    }

    /**
     * Stop monitoring connection statistics
     */
    stopStatsMonitoring() {
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
// +           this.previousStats = null;  // Clear previous stats
        }
        this.statsMonitoringState = 'stopped';
    }

    /**
     * Register a callback to receive connection statistics
     * @param {function(ConnectionStats): void} callback - Function to receive stats updates
     */
    onConnectionStats(callback) {
        this._onConnectionStatsCallback = callback;
    }

    /**
     * Gather current connection statistics
     * @private
     * @returns {Promise<ConnectionStats>} Current connection statistics
     */
    async _gatherConnectionStats() {
        if (!this.peerConnection) {
            throw new Error('No active connection');
        }

        const stats = await this.peerConnection.getStats();
        const result = {
            outbound: {
                bitrate: 0,
                packetLoss: 0,
                qualityLimitation: 'none'
            },
            inbound: {
                bitrate: 0,
                packetLoss: 0,
                jitter: 0
            },
            connection: {
                roundTripTime: 0,
                state: this.peerConnection.connectionState
            }
        };

        let outboundStats = null;
        let inboundStats = null;

        // Process each stat
        stats.forEach(stat => {
            switch (stat.type) {
                case 'outbound-rtp':
                    if (stat.kind === 'video') {
                        outboundStats = stat;
                        result.outbound.qualityLimitation = stat.qualityLimitationReason;
                    }
                    break;

                case 'inbound-rtp':
                    if (stat.kind === 'video') {
                        inboundStats = stat;
                        result.inbound.jitter = stat.jitter;
                        if (stat.packetsLost > 0) {
                            result.inbound.packetLoss = 
                                (stat.packetsLost / (stat.packetsReceived + stat.packetsLost)) * 100;
                        }
                    }
                    break;

                case 'candidate-pair':
                    if (stat.state === 'succeeded') {
                        result.connection.roundTripTime = stat.currentRoundTripTime;
                    }
                    break;
            }
        });

        // Calculate bitrates using previous stats
        if (this.previousStats && outboundStats && inboundStats) {
            const timeDelta = (outboundStats.timestamp - this.previousStats.outboundTimestamp) / 1000;  // Convert to seconds
            
            if (timeDelta > 0) {
                // Calculate outbound bitrate
                const bytesSentDelta = outboundStats.bytesSent - this.previousStats.bytesSent;
                result.outbound.bitrate = (bytesSentDelta * 8) / timeDelta;  // Convert to bits per second
                
                // Calculate inbound bitrate
                const bytesReceivedDelta = inboundStats.bytesReceived - this.previousStats.bytesReceived;
                result.inbound.bitrate = (bytesReceivedDelta * 8) / timeDelta;  // Convert to bits per second
            }
        }

        // Store current stats for next calculation
        if (outboundStats && inboundStats) {
            this.previousStats = {
                outboundTimestamp: outboundStats.timestamp,
                bytesSent: outboundStats.bytesSent,
                bytesReceived: inboundStats.bytesReceived
            };
        }

        return result;
    }

    /**
     * Get a snapshot of current connection statistics
     * @returns {Promise<ConnectionStats>} Current connection statistics
     */
    async getConnectionStats() {
        return this._gatherConnectionStats();
    }

    /**
     * Gather current connection statistics per stream
     * @private
     * @returns {Promise<Map<string, StreamStats>>} Map of session IDs to stream stats
     */
    async _gatherStreamStats() {
        if (!this.peerConnection) return new Map();

        const stats = await this.peerConnection.getStats();
        const streamStats = new Map();

        // Initialize local stats
        if (this.sessionId) {
            streamStats.set(this.sessionId, {
                sessionId: this.sessionId,
                packetLoss: 0,
                qualityLimitation: 'none',
                bitrate: 0
            });
        }

        stats.forEach(stat => {
            if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
                // Update local stream stats
                const localStats = streamStats.get(this.sessionId);
                if (localStats) {
                    localStats.qualityLimitation = stat.qualityLimitationReason;
                    localStats.bitrate = stat.bytesSent * 8 / stat.timestamp;
                }
            }
            else if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
                // Get sessionId from mid mapping
                const mid = stat.mid;
                const sessionId = this.midToSessionId.get(mid);
                
                if (sessionId) {
                    streamStats.set(sessionId, {
                        sessionId,
                        packetLoss: stat.packetsLost > 0 
                            ? (stat.packetsLost / (stat.packetsReceived + stat.packetsLost)) * 100 
                            : 0,
                        qualityLimitation: 'none',
                        bitrate: stat.bytesReceived * 8 / stat.timestamp
                    });
                }
            }
        });

        return streamStats;
    }

    // Add static QUALITY_PRESETS
    static QUALITY_PRESETS = {
        // 16:9 Presets
        high_16x9_xl: {  // 1080p
            video: {
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 30 },
                maxBitrate: 2_500_000
            },
            audio: { maxBitrate: 128000, sampleRate: 48000, channelCount: 2 }
        },
        high_16x9_lg: {  // 720p
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30 },
                maxBitrate: 1_500_000
            },
            audio: { maxBitrate: 96000, sampleRate: 48000, channelCount: 2 }
        },
        high_16x9_md: {  // 480p
            video: {
                width: { ideal: 854 },
                height: { ideal: 480 },
                frameRate: { ideal: 30 },
                maxBitrate: 800_000
            },
            audio: { maxBitrate: 96000, sampleRate: 48000, channelCount: 1 }
        },
        high_16x9_sm: {  // 360p
            video: {
                width: { ideal: 640 },
                height: { ideal: 360 },
                frameRate: { ideal: 30 },
                maxBitrate: 600_000
            },
            audio: { maxBitrate: 64000, sampleRate: 44100, channelCount: 1 }
        },
        high_16x9_xs: {  // 270p
            video: {
                width: { ideal: 480 },
                height: { ideal: 270 },
                frameRate: { ideal: 30 },
                maxBitrate: 400_000
            },
            audio: { maxBitrate: 64000, sampleRate: 44100, channelCount: 1 }
        },

        // 16:9 Medium Quality Presets (reduced framerate & bitrate)
        medium_16x9_xl: {
            video: {
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 24 },
                maxBitrate: 2_000_000
            },
            audio: { maxBitrate: 96000, sampleRate: 48000, channelCount: 2 }
        },
        medium_16x9_lg: {
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 24 },
                maxBitrate: 1_200_000
            },
            audio: { maxBitrate: 96000, sampleRate: 48000, channelCount: 1 }
        },
        medium_16x9_md: {
            video: {
                width: { ideal: 854 },
                height: { ideal: 480 },
                frameRate: { ideal: 24 },
                maxBitrate: 600_000
            },
            audio: { maxBitrate: 64000, sampleRate: 44100, channelCount: 1 }
        },
        medium_16x9_sm: {
            video: {
                width: { ideal: 640 },
                height: { ideal: 360 },
                frameRate: { ideal: 20 },
                maxBitrate: 400_000
            },
            audio: { maxBitrate: 48000, sampleRate: 44100, channelCount: 1 }
        },
        medium_16x9_xs: {
            video: {
                width: { ideal: 480 },
                height: { ideal: 270 },
                frameRate: { ideal: 20 },
                maxBitrate: 300_000
            },
            audio: { maxBitrate: 48000, sampleRate: 44100, channelCount: 1 }
        },

        // 16:9 Low Quality Presets (minimum viable quality)
        low_16x9_xl: {
            video: {
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 15 },
                maxBitrate: 1_500_000
            },
            audio: { maxBitrate: 64000, sampleRate: 44100, channelCount: 1 }
        },
        low_16x9_lg: {
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 15 },
                maxBitrate: 800_000
            },
            audio: { maxBitrate: 48000, sampleRate: 44100, channelCount: 1 }
        },
        low_16x9_md: {
            video: {
                width: { ideal: 854 },
                height: { ideal: 480 },
                frameRate: { ideal: 15 },
                maxBitrate: 400_000
            },
            audio: { maxBitrate: 32000, sampleRate: 44100, channelCount: 1 }
        },
        low_16x9_sm: {
            video: {
                width: { ideal: 640 },
                height: { ideal: 360 },
                frameRate: { ideal: 12 },
                maxBitrate: 250_000
            },
            audio: { maxBitrate: 32000, sampleRate: 22050, channelCount: 1 }
        },
        low_16x9_xs: {
            video: {
                width: { ideal: 480 },
                height: { ideal: 270 },
                frameRate: { ideal: 10 },
                maxBitrate: 150_000
            },
            audio: { maxBitrate: 24000, sampleRate: 22050, channelCount: 1 }
        },

        // 4:3 High Quality Presets (existing)
        high_4x3_xl: {  // 960x720
            video: {
                width: { ideal: 960 },
                height: { ideal: 720 },
                frameRate: { ideal: 30 },
                maxBitrate: 1_500_000
            },
            audio: { maxBitrate: 128000, sampleRate: 48000, channelCount: 2 }
        },
        high_4x3_lg: {  // 640x480
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 30 },
                maxBitrate: 800_000
            },
            audio: { maxBitrate: 96000, sampleRate: 48000, channelCount: 1 }
        },
        high_4x3_md: {  // 480x360
            video: {
                width: { ideal: 480 },
                height: { ideal: 360 },
                frameRate: { ideal: 30 },
                maxBitrate: 600_000
            },
            audio: { maxBitrate: 96000, sampleRate: 44100, channelCount: 1 }
        },
        high_4x3_sm: {  // 320x240
            video: {
                width: { ideal: 320 },
                height: { ideal: 240 },
                frameRate: { ideal: 30 },
                maxBitrate: 400_000
            },
            audio: { maxBitrate: 64000, sampleRate: 44100, channelCount: 1 }
        },
        high_4x3_xs: {  // 240x180 (perfect for 300x225 container)
            video: {
                width: { ideal: 240 },
                height: { ideal: 180 },
                frameRate: { ideal: 30 },
                maxBitrate: 250_000
            },
            audio: { maxBitrate: 64000, sampleRate: 44100, channelCount: 1 }
        },

        // 4:3 Medium Quality Presets
        medium_4x3_xl: {
            video: {
                width: { ideal: 960 },
                height: { ideal: 720 },
                frameRate: { ideal: 24 },
                maxBitrate: 1_200_000
            },
            audio: { maxBitrate: 96000, sampleRate: 48000, channelCount: 1 }
        },
        medium_4x3_lg: {
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 24 },
                maxBitrate: 600_000
            },
            audio: { maxBitrate: 64000, sampleRate: 44100, channelCount: 1 }
        },
        medium_4x3_md: {
            video: {
                width: { ideal: 480 },
                height: { ideal: 360 },
                frameRate: { ideal: 20 },
                maxBitrate: 400_000
            },
            audio: { maxBitrate: 48000, sampleRate: 44100, channelCount: 1 }
        },
        medium_4x3_sm: {
            video: {
                width: { ideal: 320 },
                height: { ideal: 240 },
                frameRate: { ideal: 20 },
                maxBitrate: 300_000
            },
            audio: { maxBitrate: 48000, sampleRate: 44100, channelCount: 1 }
        },
        medium_4x3_xs: {
            video: {
                width: { ideal: 240 },
                height: { ideal: 180 },
                frameRate: { ideal: 20 },
                maxBitrate: 200_000
            },
            audio: { maxBitrate: 48000, sampleRate: 44100, channelCount: 1 }
        },

        // 4:3 Low Quality Presets
        low_4x3_xl: {
            video: {
                width: { ideal: 960 },
                height: { ideal: 720 },
                frameRate: { ideal: 15 },
                maxBitrate: 800_000
            },
            audio: { maxBitrate: 48000, sampleRate: 44100, channelCount: 1 }
        },
        low_4x3_lg: {
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 15 },
                maxBitrate: 400_000
            },
            audio: { maxBitrate: 32000, sampleRate: 44100, channelCount: 1 }
        },
        low_4x3_md: {
            video: {
                width: { ideal: 480 },
                height: { ideal: 360 },
                frameRate: { ideal: 12 },
                maxBitrate: 250_000
            },
            audio: { maxBitrate: 32000, sampleRate: 22050, channelCount: 1 }
        },
        low_4x3_sm: {
            video: {
                width: { ideal: 320 },
                height: { ideal: 240 },
                frameRate: { ideal: 10 },
                maxBitrate: 150_000
            },
            audio: { maxBitrate: 24000, sampleRate: 22050, channelCount: 1 }
        },
        low_4x3_xs: {
            video: {
                width: { ideal: 240 },
                height: { ideal: 180 },
                frameRate: { ideal: 10 },
                maxBitrate: 100_000
            },
            audio: { maxBitrate: 24000, sampleRate: 22050, channelCount: 1 }
        }
    };
}

export default CloudflareCalls;
