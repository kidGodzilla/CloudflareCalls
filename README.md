# CloudflareCalls.js

A reference implementation of Cloudflare Calls, including a client-side library [(CloudflareCalls class)](https://cloudflarecalls.jamesfuthey.com/docs/CloudflareCalls.html), and a minimal Express [signaling server](https://cloudflarecalls.jamesfuthey.com/docs/api).

[Library Docs](https://cloudflarecalls.jamesfuthey.com/docs/) | [API (server) Docs](https://cloudflarecalls.jamesfuthey.com/docs/api) | [GitHub](https://github.com/kidGodzilla/CloudflareCalls) | [Demo](https://cloudflarecalls.jamesfuthey.com/)

# Getting Started

Cloudflare Calls requires a backend server to protect its `CLOUDFLARE_APP_ID` and `CLOUDFLARE_APP_SECRET`. These are stored as environment variables in this example.

Optionally, `CLOUDFLARE_TURN_ID` and `CLOUDFLARE_TURN_TOKEN` are used to authenticate users to Cloudflare's ICE servers.

You will receive all of these tokens and identifiers after creating a [Cloudflare Calls Serverless SFU app](https://dash.cloudflare.com/?to=/:account/calls) on your dashboard. The TURN section is optional, but recommended.

Your backend server (and our Express server in this example) is responsible for peer discovery and track discovery. Cloudflare does not provide this as part of the Calls service.

Authentication and moderation functions should be implemented on the provided routes as you see fit for your application. 

The included `/auth/token` route on the server is for demonstration only, and issues a JWT token without authentication, to demonstrate the implementation requirements in the client library and server to secure requests to SFU resources.

Everything you need to run the demo app is included in the example server, with no special dependencies. There is no database so it cannot scale past a single server instance.

## Demo

Try the [demo](https://cloudflarecalls.jamesfuthey.com/) to see how the implemented methods function in a real application.

# Usage 

## Setting up

1. Instantiate an instance of `CloudflareCalls` class:

```js
import CloudflareCalls from './CloudflareCalls.js';

const calls = new CloudflareCalls({
    backendUrl: 'http://localhost:5001',
    websocketUrl: 'ws://localhost:5001'
});
```

Additionally, Cloudflare recommends the inclusion of the [webrtc-adapter](https://cdnjs.com/libraries/webrtc-adapter/8.1.2). This is a shim to insulate apps from WebRTC spec changes and browser prefix differences.

## Establishing a call between participants

2. [Get media devices](https://cloudflarecalls.jamesfuthey.com/docs/CloudflareCalls.html#getAvailableDevices)
3. [Preview Media (optional)](https://cloudflarecalls.jamesfuthey.com/docs/CloudflareCalls.html#previewMedia)
4. Handle [onParticipantJoined](https://cloudflarecalls.jamesfuthey.com/docs/CloudflareCalls.html#onParticipantJoined), [onRemoteTrack](https://cloudflarecalls.jamesfuthey.com/docs/CloudflareCalls.html#onRemoteTrack), [onDataMessage](https://cloudflarecalls.jamesfuthey.com/docs/CloudflareCalls.html#onDataMessage)
5. [Create a room](https://cloudflarecalls.jamesfuthey.com/docs/CloudflareCalls.html#createRoom) (only one participant needs to do this, returns a GUID)
6. [Join a room](https://cloudflarecalls.jamesfuthey.com/docs/CloudflareCalls.html#joinRoom) (by GUID)

You can see an example of this flow in the example included at `public/index.html`.

# Not yet implemented

- ~~SFU datachannels are not implemented (and probably only make sense for file transfers)~~
- ~~You cannot enable/disable audio or video~~
- ~~You cannot switch inputs after a track has been published~~
- ~~Tracks are not correctly unpublished in most cases~~
- ~~Participant list (text list) does not update properly~~
- ~~Screen sharing does not work~~
- Cannot publish tracks after unpublishing tracks
- Leave existing room when clicking Join Room button in room list
- More..