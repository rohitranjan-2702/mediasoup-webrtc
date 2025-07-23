import express from "express";
import http from "http";
import { Server } from "socket.io";
import * as mediasoup from "mediasoup";
import type { types } from "mediasoup";
import { config } from "./config";
import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import path from "path";

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
let videoRtpTransports: types.PlainTransport[] = [];
let audioRtpTransports: types.PlainTransport[] = [];
let ffmpegProcess: any = null;

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

  // Initialize RTP transports for the fixed ports in SDP
  await initializeRtpTransports();
};

const initializeRtpTransports = async () => {
  try {
    // Create video RTP transport for port 5004 (first video stream)
    const videoTransport1 = await router.createPlainTransport({
      listenIp: config.rtpPlayer.listenIp,
      rtcpMux: false,
      comedia: false,
    });
    await videoTransport1.connect({
      ip: config.rtpPlayer.listenIp,
      port: config.rtpPlayer.videoPort, // 5004
      rtcpPort: config.rtpPlayer.videoPort + 1, // 5005
    });
    videoRtpTransports.push(videoTransport1);
    console.log(
      `Video RTP transport 1 connected on port ${config.rtpPlayer.videoPort}`
    );

    // Create video RTP transport for port 5008 (second video stream)
    const videoTransport2 = await router.createPlainTransport({
      listenIp: config.rtpPlayer.listenIp,
      rtcpMux: false,
      comedia: false,
    });
    await videoTransport2.connect({
      ip: config.rtpPlayer.listenIp,
      port: config.rtpPlayer.videoPort2, // 5008
      rtcpPort: config.rtpPlayer.videoPort2 + 1, // 5009
    });
    videoRtpTransports.push(videoTransport2);
    console.log(
      `Video RTP transport 2 connected on port ${config.rtpPlayer.videoPort2}`
    );

    // Create audio RTP transport for port 5006 (first audio stream)
    const audioTransport1 = await router.createPlainTransport({
      listenIp: config.rtpPlayer.listenIp,
      rtcpMux: false,
      comedia: false,
    });
    await audioTransport1.connect({
      ip: config.rtpPlayer.listenIp,
      port: config.rtpPlayer.audioPort, // 5006
      rtcpPort: config.rtpPlayer.audioPort + 1, // 5007
    });
    audioRtpTransports.push(audioTransport1);
    console.log(
      `Audio RTP transport 1 connected on port ${config.rtpPlayer.audioPort}`
    );

    // Create audio RTP transport for port 5010 (second audio stream)
    const audioTransport2 = await router.createPlainTransport({
      listenIp: config.rtpPlayer.listenIp,
      rtcpMux: false,
      comedia: false,
    });
    await audioTransport2.connect({
      ip: config.rtpPlayer.listenIp,
      port: config.rtpPlayer.audioPort2, // 5010
      rtcpPort: config.rtpPlayer.audioPort2 + 1, // 5011
    });
    audioRtpTransports.push(audioTransport2);
    console.log(
      `Audio RTP transport 2 connected on port ${config.rtpPlayer.audioPort2}`
    );

    console.log("All RTP transports initialized successfully");
  } catch (error) {
    console.error("Failed to initialize RTP transports:", error);
  }
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
    callback(router?.rtpCapabilities);
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

      // Start FFmpeg when we have two peers and it's not already running
      if (peers.size === 2 && !ffmpegProcess) {
        console.log("Two peers detected, starting FFmpeg process...");
        startFFmpegProcess();
      }

      // Create RTP consumer for this producer
      await createRtpConsumer(producer, socket.id);

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

  // Track producer assignments to ensure proper stream ordering
  const producerAssignments = new Map<string, number>(); // producerId -> transportIndex

  const createRtpConsumer = async (
    producer: types.Producer,
    peerSocketId: string
  ) => {
    try {
      // Determine transport index based on peer order (0 for first peer, 1 for second peer)
      const peerIds = Array.from(peers.keys());
      const peerIndex = peerIds.indexOf(peerSocketId);

      if (peerIndex === -1 || peerIndex > 1) {
        console.error(
          `Invalid peer index ${peerIndex} for peer ${peerSocketId}`
        );
        return;
      }

      const transportIndex = peerIndex; // 0 for first peer, 1 for second peer
      const rtpTransports =
        producer.kind === "video" ? videoRtpTransports : audioRtpTransports;
      const rtpTransport = rtpTransports[transportIndex];

      if (!rtpTransport) {
        console.error(
          `No RTP transport available for ${producer.kind} at index ${transportIndex}`
        );
        return;
      }

      // Store the assignment for tracking
      producerAssignments.set(producer.id, transportIndex);

      // Use router's RTP capabilities as-is, without modification
      const consumer = await rtpTransport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
      });

      const ports =
        producer.kind === "video"
          ? [config.rtpPlayer.videoPort, config.rtpPlayer.videoPort2]
          : [config.rtpPlayer.audioPort, config.rtpPlayer.audioPort2];

      console.log(`Created RTP consumer for ${producer.kind}:`, {
        producerId: producer.id,
        consumerId: consumer.id,
        peerIndex: peerIndex,
        transportIndex: transportIndex,
        port: ports[transportIndex],
        payloadType: consumer.rtpParameters.codecs[0]?.payloadType,
      });

      consumer.on("transportclose", () => {
        console.log(`RTP consumer closed for ${producer.kind}`);
        producerAssignments.delete(producer.id);
      });

      consumer.on("producerclose", () => {
        console.log(
          `RTP consumer closed due to producer close for ${producer.kind}`
        );
        producerAssignments.delete(producer.id);
      });
    } catch (error) {
      console.error(
        `Failed to create RTP consumer for ${producer.kind}:`,
        error
      );
    }
  };

  const startFFmpegProcess = () => {
    console.info("Starting FFmpeg process...");

    // Ensure output directory exists
    const outputDir = path.resolve(__dirname, "../../fermion-app/public/live");
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
      console.log(`Created output directory: ${outputDir}`);
    }

    const ffmpegArgs = [
      "-protocol_whitelist",
      "file,udp,rtp",
      // FFmpeg flags for better RTP handling
      "-fflags",
      "+genpts",
      "-analyzeduration",
      "3000000",
      "-probesize",
      "3000000",
      "-max_delay",
      "500000",
      "-buffer_size",
      "65536",
      // Input
      "-i",
      "./stream.sdp",
      // Filter complex: scale both videos and combine side by side, merge audio
      "-filter_complex",
      "[0:0]scale=960:720[v0]; [0:2]scale=960:720[v1]; [v0][v1]hstack=inputs=2[v]; [0:1][0:3]amerge=inputs=2[a]",
      // Mapping - map the filter outputs
      "-map",
      "[v]",
      "-map",
      "[a]",
      // Video codec settings
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "30", // GOP size for better seeking
      "-sc_threshold",
      "0", // Disable scene change detection
      // Audio codec settings
      "-c:a",
      "aac",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-b:a",
      "128k",
      // HLS settings
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
      "-hls_segment_type",
      "mpegts",
      path.resolve(outputDir, "stream.m3u8"),
    ];

    ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
      cwd: "src", // Set working directory to src so stream.sdp path works
    });

    ffmpegProcess.stdout.on("data", (data: Buffer) => {
      console.log(`ffmpeg stdout: ${data.toString()}`);
    });

    ffmpegProcess.stderr.on("data", (data: Buffer) => {
      console.log(`ffmpeg stderr: ${data.toString()}`);
    });

    ffmpegProcess.on("close", (code: number) => {
      console.log(`ffmpeg process exited with code ${code}`);
      ffmpegProcess = null;
    });

    ffmpegProcess.on("error", (error: Error) => {
      console.error("FFmpeg process error:", error);
      ffmpegProcess = null;
    });
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
