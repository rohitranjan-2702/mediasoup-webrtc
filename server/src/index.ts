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
let videoRtpTransport: types.PlainTransport | null = null;
let audioRtpTransport: types.PlainTransport | null = null;
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
      await setupRtpStreaming();

      // Create RTP consumer for this producer
      await createRtpConsumer(producer);

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

  const setupRtpStreaming = async () => {
    try {
      // Create video RTP transport if it doesn't exist
      if (!videoRtpTransport) {
        videoRtpTransport = await router.createPlainTransport({
          listenIp: config.rtpPlayer.listenIp,
          rtcpMux: false,
          comedia: false,
        });

        await videoRtpTransport.connect({
          ip: config.rtpPlayer.listenIp,
          port: config.rtpPlayer.videoPort,
          rtcpPort: config.rtpPlayer.videoPort + 1,
        });
        console.log(
          `Video RTP transport connected on port ${config.rtpPlayer.videoPort}`
        );
      }

      // Create audio RTP transport if it doesn't exist
      if (!audioRtpTransport) {
        audioRtpTransport = await router.createPlainTransport({
          listenIp: config.rtpPlayer.listenIp,
          rtcpMux: false,
          comedia: false,
        });

        await audioRtpTransport.connect({
          ip: config.rtpPlayer.listenIp,
          port: config.rtpPlayer.audioPort,
          rtcpPort: config.rtpPlayer.audioPort + 1,
        });
        console.log(
          `Audio RTP transport connected on port ${config.rtpPlayer.audioPort}`
        );
      }

      // Start FFmpeg process if not already running
      if (!ffmpegProcess) {
        startFFmpegProcess();
      }
    } catch (error) {
      console.error("Failed to setup RTP streaming:", error);
    }
  };

  const createRtpConsumer = async (producer: types.Producer) => {
    try {
      const rtpTransport =
        producer.kind === "video" ? videoRtpTransport : audioRtpTransport;

      if (!rtpTransport) {
        console.error(`No RTP transport available for ${producer.kind}`);
        return;
      }

      // Use router's RTP capabilities as-is, without modification
      const consumer = await rtpTransport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
      });

      console.log(`Created RTP consumer for ${producer.kind}:`, {
        producerId: producer.id,
        consumerId: consumer.id,
        payloadType: consumer.rtpParameters.codecs[0]?.payloadType,
      });

      consumer.on("transportclose", () => {
        console.log(`RTP consumer closed for ${producer.kind}`);
      });

      consumer.on("producerclose", () => {
        console.log(
          `RTP consumer closed due to producer close for ${producer.kind}`
        );
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
      "-i",
      "./stream.sdp", // Fixed path - relative to current working directory
      "-map",
      "0:v?", // ? makes it optional
      "-map",
      "0:a?", // ? makes it optional
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
      path.resolve(outputDir, "stream.m3u8"), // Use absolute path
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
