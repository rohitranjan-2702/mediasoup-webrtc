import express from "express";
import http from "http";
import { Server } from "socket.io";
import * as mediasoup from "mediasoup";
import type { types } from "mediasoup";
import { config } from "./config";
import { spawn } from "child_process";

type Peer = {
  transports: Map<string, types.WebRtcTransport>;
  producers: Map<string, types.Producer>;
  consumers: Map<string, types.Consumer>;
};
const peers = new Map<string, Peer>();

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // local
  },
});

let worker: types.Worker;
let router: types.Router;
let rtpTransport: types.PlainTransport | null = null;

const startMediasoup = async () => {
  worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags as types.WorkerLogTag[],
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on("died", () => {
    console.error("mediasoup worker has died");
    setTimeout(() => process.exit(1), 2000); // exit in 2 seconds
  });

  router = await worker.createRouter({
    mediaCodecs: config.mediasoup.router.mediaCodecs,
  });
  console.info("Mediasoup router created");
};

startMediasoup();

httpServer.listen(config.listenPort, () => {
  console.info(`🚀 Server is listening on port ${config.listenPort}`);
});

io.on("connection", (socket) => {
  peers.set(socket.id, {
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
  });
  console.info("A client connected:", socket.id);

  // Send existing producers from all other peers to the newly connected client
  const existingProducers: { producerId: string; socketId: string }[] = [];
  for (const [otherSocketId, otherPeer] of peers.entries()) {
    if (otherSocketId !== socket.id) {
      for (const [producerId] of otherPeer.producers) {
        existingProducers.push({ producerId, socketId: otherSocketId });
      }
    }
  }
  socket.emit("existingProducers", existingProducers);

  socket.on("disconnect", () => {
    const peer = peers.get(socket.id);
    if (peer) {
      peer.transports.forEach((t) => t.close());
      peer.producers.forEach((p) => p.close());
      peer.consumers.forEach((c) => c.close());
      peers.delete(socket.id);
    }
    console.info("Client disconnected:", socket.id);
  });

  // --- Signaling Events ---

  // 1. Client asks for Router's capabilities
  socket.on("getRouterRtpCapabilities", (callback) => {
    callback(router.rtpCapabilities);
  });

  // 2. Client asks to create a transport
  socket.on("createWebRtcTransport", async ({ isSender }, callback) => {
    try {
      const transport = await router.createWebRtcTransport(
        config.mediasoup.webRtcTransport
      );
      const peer = peers.get(socket.id);
      if (peer) {
        peer.transports.set(transport.id, transport);
      }

      transport.on("dtlsstatechange", (dtlsState: string) => {
        if (dtlsState === "closed") {
          transport.close();
          const peer = peers.get(socket.id);
          if (peer) {
            peer.transports.delete(transport.id);
          }
        }
      });

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    } catch (error) {
      const err = error as Error;
      console.error("Failed to create WebRTC transport:", err);
      callback({ error: err.message });
    }
  });

  // 3. Client connects the transport
  socket.on(
    "connectWebRtcTransport",
    async ({ transportId, dtlsParameters }, callback) => {
      const peer = peers.get(socket.id);
      if (!peer) {
        console.error("Peer not found for connect:", socket.id);
        return callback({ error: "Peer not found" });
      }
      const transport = peer.transports.get(transportId);
      if (!transport) {
        console.error("Transport not found for connect:", transportId);
        return callback({ error: "Transport not found" });
      }
      await transport.connect({ dtlsParameters });
      callback();
    }
  );

  // 4. Client wants to produce (send) media
  socket.on(
    "produce",
    async ({ transportId, kind, rtpParameters }, callback) => {
      const peer = peers.get(socket.id);
      if (!peer) {
        console.error("Peer not found for produce:", socket.id);
        return callback({ error: "Peer not found" });
      }
      const transport = peer.transports.get(transportId);
      if (!transport) {
        console.error("Transport not found for produce:", transportId);
        return callback({ error: "Transport not found" });
      }
      const producer = await transport.produce({ kind, rtpParameters });

      peer.producers.set(producer.id, producer);

      // Start RTP broadcast when we have our first producer
      if (!rtpTransport) {
        await startRtpBroadcast();
      }

      // Consume this new producer with our RTP transport
      if (rtpTransport) {
        try {
          // For RTP transport, we need to specify the right payload type
          const rtpCapabilities = {
            ...router.rtpCapabilities,
            codecs:
              router.rtpCapabilities.codecs?.map((codec) => {
                if (codec.kind === kind) {
                  // Map to the payload types we defined in SDP
                  if (kind === "video" && codec.mimeType === "video/VP8") {
                    return { ...codec, preferredPayloadType: 101 };
                  } else if (
                    kind === "audio" &&
                    codec.mimeType === "audio/opus"
                  ) {
                    return { ...codec, preferredPayloadType: 100 };
                  }
                }
                return codec;
              }) || [],
          };

          console.log("rtpCapabilities", rtpCapabilities);
          const consumer = await rtpTransport.consume({
            producerId: producer.id,
            rtpCapabilities,
          });

          console.log(`Consumer RTP parameters:`, consumer.rtpParameters);
        } catch (error) {
          console.error(`Failed to create RTP consumer for ${kind}:`, error);
        }
      }

      // Inform all other clients that a new producer is available
      socket.broadcast.emit("new-producer", {
        producerId: producer.id,
        socketId: socket.id,
      });

      // Send existing producers to the client that just started producing
      const otherProducers: { producerId: string; socketId: string }[] = [];
      for (const [otherSocketId, otherPeer] of peers.entries()) {
        if (otherSocketId !== socket.id) {
          for (const [producerId] of otherPeer.producers) {
            otherProducers.push({ producerId, socketId: otherSocketId });
          }
        }
      }

      if (otherProducers.length > 0) {
        socket.emit("existingProducers", [...otherProducers]);
      }

      callback({ id: producer.id });

      producer.on("transportclose", () => {
        producer.close();
        peer.producers.delete(producer.id);
      });
    }
  );

  const startRtpBroadcast = async () => {
    try {
      // Skip if RTP transport already exists
      if (rtpTransport) {
        return;
      }

      // Create a PlainTransport for RTP forwarding
      rtpTransport = await router.createPlainTransport({
        listenIp: config.rtpPlayer.listenIp,
        rtcpMux: false,
        comedia: false,
      });

      console.log("RTP transport created for HLS broadcast");

      // Connect to specific video port (FFmpeg will read from this)
      const videoPort = config.rtpPlayer.videoPort;

      await rtpTransport.connect({
        ip: config.rtpPlayer.listenIp,
        port: videoPort,
        rtcpPort: videoPort + 1,
      });
      console.log(`RTP transport connected on port ${videoPort}`);

      // This is where you would start the ffmpeg process
      console.info("Starting FFMpeg process...");

      const ffmpegArgs = [
        "-protocol_whitelist",
        "file,udp,rtp",
        "-fflags",
        "+genpts",
        "-analyzeduration",
        "10000000",
        "-probesize",
        "10000000",
        "-i",
        "src/stream.sdp",
        "-map",
        "0:v",
        "-map",
        "0:a",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-f",
        "hls",
        "-hls_time",
        "2",
        "-hls_list_size",
        "5",
        "-hls_flags",
        "delete_segments+append_list",
        "-hls_allow_cache",
        "0",
        "../fermion-app/public/live/stream.m3u8",
      ];

      const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

      ffmpegProcess.stdout.on("data", (data) => {
        // You can log FFMpeg's output for debugging
        console.log(`ffmpeg stdout: ${data}`);
      });

      ffmpegProcess.stderr.on("data", (data) => {
        console.error(`ffmpeg stderr: ${data}`);
      });

      ffmpegProcess.on("close", (code) => {
        console.error(`ffmpeg process exited with code ${code}`);
      });
    } catch (error) {
      console.error("Failed to start RTP broadcast:", error);
    }
  };

  // 5. Client wants to consume (receive) media
  socket.on(
    "consume",
    async ({ transportId, producerId, rtpCapabilities }, callback) => {
      const peer = peers.get(socket.id);
      if (!peer) {
        console.error("Peer not found for consume:", socket.id);
        return callback({ error: "Peer not found" });
      }
      const transport = peer.transports.get(transportId);
      if (!transport) {
        return callback({ error: "Receiving transport not found" });
      }

      if (!router.canConsume({ producerId, rtpCapabilities })) {
        console.error("Cannot consume");
        return callback({ error: "Cannot consume" });
      }

      try {
        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: true, // Start paused
        });
        peer.consumers.set(consumer.id, consumer);

        consumer.on("transportclose", () => {
          consumer.close();
          peer.consumers.delete(consumer.id);
        });

        consumer.on("producerclose", () => {
          consumer.close();
          peer.consumers.delete(consumer.id);
        });

        callback({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } catch (error) {
        const err = error as Error;
        console.error("Consume error:", err);
        callback({ error: err.message });
      }
    }
  );

  // Client requests to resume a consumer
  socket.on("resume", async ({ consumerId }, callback) => {
    const peer = peers.get(socket.id);
    if (!peer) {
      console.error("Peer not found for resume:", socket.id);
      return callback({ error: "Peer not found" });
    }
    const consumer = peer.consumers.get(consumerId);
    if (consumer) {
      await consumer.resume();
    }
    callback();
  });
});
