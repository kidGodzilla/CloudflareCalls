# CloudflareCallsLibrary.js

A reference implementation of Cloudflare Calls, including a client-side library [(CloudflareCalls class)](/docs/CloudflareCalls.html), and a minimal Express [signaling server](/docs/api).

[Library Docs](/docs/) | [API (server) Docs](/docs/api) | [Demo](/)

# Getting Started

Cloudflare Calls requires a backend server to protect its `CLOUDFLARE_APP_ID` and `CLOUDFLARE_APP_SECRET`. These are stored as environment variables in this example.

Optionally, `CLOUDFLARE_TURN_ID` and `CLOUDFLARE_TURN_TOKEN` are used to authenticate users to Cloudflare's ICE servers.

You will receive all of these tokens and identifiers after creating a [Cloudflare Calls Serverless SFU app](https://dash.cloudflare.com/?to=/:account/calls) on your dashboard. The TURN section is optional, but recommended.

Your backend server (and our Express server in this example) is responsible for peer discovery and track discovery. Cloudflare does not provide this as part of the Calls service.

Authentication and moderation functions should be implemented on the provided routes as you see fit for your application. A future version of this example may implement this, since it should be the responsibility of the library to amend each request with authorization headers.

Everything you need to run the demo app is included in the example server, with no special dependencies. There is no database so it cannot scale past a single server instance.

## Demo

Try the [demo](/) to see how the implemented methods function in a real application.

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

2. [Get media devices](/docs/CloudflareCalls.html#getAvailableDevices)
3. [Preview Media (optional)](/docs/CloudflareCalls.html#previewMedia)
4. Handle [onParticipantJoined](/docs/CloudflareCalls.html#onParticipantJoined), [onRemoteTrack](/docs/CloudflareCalls.html#onRemoteTrack), [onDataMessage](/docs/CloudflareCalls.html#onDataMessage)
5. [Create a room](/docs/CloudflareCalls.html#createRoom) (only one participant needs to do this, returns a GUID)
6. [Join a room](/docs/CloudflareCalls.html#joinRoom) (by GUID)

You can see an example of this flow in the example included at `public/index.html`.