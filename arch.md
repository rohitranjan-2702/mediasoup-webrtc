## Current Architecture

The current arch. consists of a client (our Next.js App) and a server (nodejs). We are using socket.io to implement the signaling of events between both the system. The client makes a websocket connection with our server (listening at port:3001) which is used to communicate the realtime events happening at both ends. 

There is a mediasoup-client, that is initiated at the socket connection with the server, which handles all the responsibility of sending and recieving streams of data (audio/video). When a new mediasoup-client is created and a transport (webrtcTransport) is established with the server , the client is registered as a producer at the server (maintained in a Map()).

producer -> represents an incoming media stream
tansport -> represents the network connection between a client and the Mediasoup server.
consumer -> represents an outgoing media stream.

Now when a second client comes, and do all the above things, it also consumes the previous stream as a consumer. That means, client-1 becomes a producer of its own media-stream and a consumer of client-2's media-stream and vice-versa for client-2.

This pretty much sums up the realtime communication between two clients, now jumping to the watch part, which enables a 3rd client to watch client-1 and client-2 interact. When both the producer are created, a new transport (plainTransport) is also created for each media stream (i.e, two more transport, each for audio and video), which helps in feeding the incoming media-stream from clients to the ffmpeg process, listening on port 5004,5006 for client-1 & 5008, 5010 for client-2.

Ffmpeg consumes all the four streams, combine them into a single video using its transcoding capability, and give a HLS stream that has video and audio for both the clients. This stream is server to the client on the `/watch` page.


## Some scaling questions

1. How do you handle the latency difference between WebRTC participants (~100ms) and HLS viewers (~6-15 seconds)?

Ans. 

2. What happens if a 3rd person tries to join /stream? Why not dynamic port allocation for N participants?

Ans.

3. How can we scale this from 2 users to more?

Ans.

4. How do you handle cases where only 1 person is streaming (empty video slot)?

Ans. 

5. How do you handle FFmpeg crashes or codec issues in production?

Ans.

6. What happens if MediaSoup worker dies during active streams?

Ans.

7. How do you handle TURN servers for production WebRTC deployment?

Ans.