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

        // Track management
        this.pulledTracks = new Map(); // Map<sessionId, Set<trackName>>
        this.pollingInterval = null; // Reference to the polling interval

        // Device management
        this.availableAudioInputDevices = [];
        this.availableVideoInputDevices = [];
        this.availableAudioOutputDevices = [];
        this.currentAudioOutputDeviceId = null;
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

    /************************************************
     * User Metadata Management
     ***********************************************/

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
            const response = await fetch(updateUrl, {
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
        const resp = await fetch(`${this.backendUrl}/api/rooms`, { method: 'POST' })
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
        const joinResp = await fetch(`${this.backendUrl}/api/rooms/${roomId}/join`, {
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
        await fetch(`${this.backendUrl}/api/rooms/${this.roomId}/sessions/${this.sessionId}/unpublish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        console.log('Unpublished all local tracks.');
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
        const resp = await fetch(publishUrl, {
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

        const resp = await fetch(pullUrl, {
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
            await this.peerConnection.setRemoteDescription(resp.sessionDescription);
            const localAnswer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(localAnswer);
            await fetch(`${this.backendUrl}/api/rooms/${this.roomId}/sessions/${this.sessionId}/renegotiate`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sdp: localAnswer.sdp, type: localAnswer.type })
            });
        }
        console.log(`Pulled trackName="${trackName}" from session ${remoteSessionId}`);

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
            const response = await fetch(`${this.backendUrl}/api/ice-servers`);
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
            console.log('ontrack =>', evt.track.kind, evt.track.id);
            if (this._onRemoteTrackCallback) {
                // Attach sessionId to the track object for identification if needed
                evt.track.sessionId = evt.transceiver.mid;
                this._onRemoteTrackCallback(evt.track);
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
                    payload: { roomId: this.roomId, userId: this.userId }
                }));
                resolve();
            };
            this.ws.onmessage = async (evt) => {
                const { type, payload } = JSON.parse(evt.data);

                if (type === 'participant-joined') {
                    console.log('New participant =>', payload.sessionId, this.roomId);

                    if (!this.pulledTracks.has(payload.sessionId)) {
                        this.pulledTracks.set(payload.sessionId, new Set());
                    }

                    if (this._onParticipantJoinedCallback) {
                        this._onParticipantJoinedCallback(payload);
                    }

                    // Next, fetch that participant’s publishedTracks
                    const trackList = await fetch(
                        `${this.backendUrl}/api/rooms/${this.roomId}/participant/${payload.sessionId}/tracks`
                    ).then(res => res.json());

                    console.log('trackList', trackList);

                    // Now pull each track
                    for (const tName of trackList) {
                        if (!this.pulledTracks.get(payload.sessionId).has(tName)) {
                            console.log('_pullTracks', payload.sessionId, tName);
                            await this._pullTracks(payload.sessionId, tName);
                        }
                    }

                } else if (type === 'track-published') {
                    const { sessionId, trackNames } = payload;
                    for (const tName of trackNames) {
                        if (!this.pulledTracks.has(sessionId)) {
                            this.pulledTracks.set(sessionId, new Set());
                        }
                        if (!this.pulledTracks.get(sessionId).has(tName)) {
                            await this._pullTracks(sessionId, tName);
                        }
                    }

                } else if (type === 'participant-left') {
                    const { sessionId } = payload;
                    if (this._onParticipantLeftCallback) {
                        this._onParticipantLeftCallback(sessionId);
                    }
                    this._removeParticipantTracks(sessionId);
                    this.pulledTracks.delete(sessionId);
                } else if (type === 'data-message') {
                    // Handle incoming data messages
                    if (this._onDataMessageCallback) {
                        this._onDataMessageCallback(payload);
                    }
                }
                // else handle other messages as needed
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
                const resp = await fetch(`${this.backendUrl}/api/rooms/${this.roomId}/participants`)
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
        // Remove media elements associated with a participant
        const videos = document.querySelectorAll(`[data-session-id="${sessionId}"][data-track-kind="video"]`);
        const audios = document.querySelectorAll(`[data-session-id="${sessionId}"][data-track-kind="audio"]`);
        videos.forEach(video => video.remove());
        audios.forEach(audio => audio.remove());

        console.log(`Removed all tracks for sessionId: ${sessionId}`);
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
     * @param {boolean} [options.video=true] - Whether to toggle video tracks.
     * @param {boolean} [options.audio=true] - Whether to toggle audio tracks.
     * @returns {void}
     */
    toggleMedia({ video = true, audio = true }) {
        if (!this.localStream) return;

        if (video) {
            this.localStream.getVideoTracks().forEach(track => {
                track.enabled = !track.enabled;
                console.log(`Video track ${track.id} enabled: ${track.enabled}`);
            });
        }

        if (audio) {
            this.localStream.getAudioTracks().forEach(track => {
                track.enabled = !track.enabled;
                console.log(`Audio track ${track.id} enabled: ${track.enabled}`);
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
            const resp = await fetch(publishUrl, {
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
        await fetch(`${this.backendUrl}/api/rooms/${this.roomId}/sessions/${this.sessionId}/unpublish`, {
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

        const resp = await fetch(`${this.backendUrl}/api/rooms/${this.roomId}/participants`)
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
        const response = await fetch(`${this.backendUrl}${apiPath}`, {
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
}

export default CloudflareCalls;
