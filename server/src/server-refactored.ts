import express from "express";
import http from "http";
import { Server } from "socket.io";
import type { Socket } from "socket.io";
import type { types } from "mediasoup";
import { config } from "./config";
import { FFmpegService } from "./services/FFmpegService";
import { MediasoupService } from "./services/MediasoupService";
import { PeerManager } from "./services/PeerManager";
import type {
  SocketEventPayloads,
  TransportInfo,
  ConsumerInfo,
} from "./types";

class WebRTCServer {
  private app: express.Application;
  private httpServer: http.Server;
  private io: Server;
  private ffmpegService: FFmpegService;
  private mediasoupService: MediasoupService;
  private peerManager: PeerManager;

  constructor() {
    this.app = express();
    this.httpServer = http.createServer(this.app);
    this.io = new Server(this.httpServer, {
      cors: { origin: "*" },
    });

    this.ffmpegService = new FFmpegService();
    this.mediasoupService = new MediasoupService();
    this.peerManager = new PeerManager();

    this.setupGracefulShutdown();
  }

  public async start(): Promise<void> {
    try {
      await this.mediasoupService.initialize();
      this.ffmpegService.start();
      this.setupSocketHandlers();
      
      this.httpServer.listen(config.listenPort, () => {
        console.info(`🚀 Server is listening on port ${config.listenPort}`);
      });
    } catch (error) {
      console.error("Failed to start server:", error);
      await this.cleanup();
      process.exit(1);
    }
  }

  private setupSocketHandlers(): void {
    this.io.on("connection", (socket: Socket) => {
      this.handleConnection(socket);
    });
  }

  private handleConnection(socket: Socket): void {
    console.info("Client connected:", socket.id);
    
    this.peerManager.addPeer(socket.id);
    
    // Send existing producers to the newly connected client
    const existingProducers = this.peerManager.getExistingProducers(socket.id);
    socket.emit("existingProducers", existingProducers);

    this.setupSocketEventHandlers(socket);

    socket.on("disconnect", () => {
      this.handleDisconnection(socket.id);
    });
  }

  private setupSocketEventHandlers(socket: Socket): void {
    socket.on("getRouterRtpCapabilities", (callback) => {
      this.handleGetRouterRtpCapabilities(callback);
    });

    socket.on("createWebRtcTransport", (data: SocketEventPayloads["createWebRtcTransport"], callback) => {
      this.handleCreateWebRtcTransport(socket.id, data, callback);
    });

    socket.on("connectWebRtcTransport", (data: SocketEventPayloads["connectWebRtcTransport"], callback) => {
      this.handleConnectWebRtcTransport(socket.id, data, callback);
    });

    socket.on("produce", (data: SocketEventPayloads["produce"], callback) => {
      this.handleProduce(socket, data, callback);
    });

    socket.on("consume", (data: SocketEventPayloads["consume"], callback) => {
      this.handleConsume(socket.id, data, callback);
    });

    socket.on("resume", (data: SocketEventPayloads["resume"], callback) => {
      this.handleResume(socket.id, data, callback);
    });
  }

  private handleDisconnection(socketId: string): void {
    this.peerManager.removePeer(socketId);
    console.info("Client disconnected:", socketId);
  }

  private handleGetRouterRtpCapabilities(callback: (capabilities: types.RtpCapabilities) => void): void {
    try {
      const capabilities = this.mediasoupService.getRtpCapabilities();
      callback(capabilities);
    } catch (error) {
      console.error("Failed to get router RTP capabilities:", error);
      callback({} as types.RtpCapabilities);
    }
  }

  private async handleCreateWebRtcTransport(
    socketId: string,
    data: SocketEventPayloads["createWebRtcTransport"],
    callback: (response: TransportInfo | { error: string }) => void
  ): Promise<void> {
    try {
      const transport = await this.mediasoupService.createWebRtcTransport();
      this.peerManager.addTransport(socketId, transport);

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
  }

  private async handleConnectWebRtcTransport(
    socketId: string,
    data: SocketEventPayloads["connectWebRtcTransport"],
    callback: (response?: { error: string }) => void
  ): Promise<void> {
    try {
      const transport = this.peerManager.getTransport(socketId, data.transportId);
      
      if (!transport) {
        console.error("Transport not found for connect:", data.transportId);
        return callback({ error: "Transport not found" });
      }

      await transport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    } catch (error) {
      const err = error as Error;
      console.error("Failed to connect WebRTC transport:", err);
      callback({ error: err.message });
    }
  }

  private async handleProduce(
    socket: Socket,
    data: SocketEventPayloads["produce"],
    callback: (response: { id: string } | { error: string }) => void
  ): Promise<void> {
    try {
      const transport = this.peerManager.getTransport(socket.id, data.transportId);
      
      if (!transport) {
        console.error("Transport not found for produce:", data.transportId);
        return callback({ error: "Transport not found" });
      }

      const producer = await transport.produce({
        kind: data.kind as types.MediaKind,
        rtpParameters: data.rtpParameters,
      });

      this.peerManager.addProducer(socket.id, producer);

      // Create RTP consumer for this producer
      await this.createRtpConsumerForProducer(producer, socket.id);

      // Notify other clients about the new producer
      socket.broadcast.emit("new-producer", {
        producerId: producer.id,
        socketId: socket.id,
      });

      // Send existing producers to this client
      const existingProducers = this.peerManager.getExistingProducers(socket.id);
      if (existingProducers.length > 0) {
        socket.emit("existingProducers", existingProducers);
      }

      callback({ id: producer.id });
    } catch (error) {
      const err = error as Error;
      console.error("Failed to produce:", err);
      callback({ error: err.message });
    }
  }

  private async handleConsume(
    socketId: string,
    data: SocketEventPayloads["consume"],
    callback: (response: ConsumerInfo | { error: string }) => void
  ): Promise<void> {
    try {
      const transport = this.peerManager.getTransport(socketId, data.transportId);
      
      if (!transport) {
        return callback({ error: "Receiving transport not found" });
      }

      if (!this.mediasoupService.canConsume({
        producerId: data.producerId,
        rtpCapabilities: data.rtpCapabilities,
      })) {
        console.error("Cannot consume");
        return callback({ error: "Cannot consume" });
      }

      const consumer = await transport.consume({
        producerId: data.producerId,
        rtpCapabilities: data.rtpCapabilities,
        paused: true,
      });

      this.peerManager.addConsumer(socketId, consumer);

      callback({
        id: consumer.id,
        producerId: data.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (error) {
      const err = error as Error;
      console.error("Consume error:", err);
      callback({ error: err.message });
    }
  }

  private async handleResume(
    socketId: string,
    data: SocketEventPayloads["resume"],
    callback: (response?: { error: string }) => void
  ): Promise<void> {
    try {
      const consumer = this.peerManager.getConsumer(socketId, data.consumerId);
      
      if (!consumer) {
        console.error("Consumer not found for resume:", data.consumerId);
        return callback({ error: "Consumer not found" });
      }

      await consumer.resume();
      callback();
    } catch (error) {
      const err = error as Error;
      console.error("Failed to resume consumer:", err);
      callback({ error: err.message });
    }
  }

  private async createRtpConsumerForProducer(
    producer: types.Producer,
    socketId: string
  ): Promise<void> {
    const transportIndex = this.peerManager.getProducerTransportIndex(socketId);
    
    if (transportIndex === -1) {
      console.error(`Invalid transport index for peer ${socketId}`);
      return;
    }

    const consumer = await this.mediasoupService.createRtpConsumer(
      producer,
      transportIndex
    );

    if (consumer) {
      this.peerManager.setProducerAssignment(producer.id, transportIndex);
    }
  }

  private setupGracefulShutdown(): void {
    const cleanup = async (signal: string) => {
      console.info(`Received ${signal}. Shutting down gracefully...`);
      await this.cleanup();
      process.exit(0);
    };

    process.on("SIGTERM", () => cleanup("SIGTERM"));
    process.on("SIGINT", () => cleanup("SIGINT"));
    process.on("uncaughtException", (error) => {
      console.error("Uncaught Exception:", error);
      cleanup("uncaughtException");
    });
    process.on("unhandledRejection", (reason, promise) => {
      console.error("Unhandled Rejection at:", promise, "reason:", reason);
      cleanup("unhandledRejection");
    });
  }

  private async cleanup(): Promise<void> {
    console.info("Starting cleanup...");
    
    try {
      // Stop FFmpeg process
      this.ffmpegService.stop();
      
      // Cleanup all peers
      const peerIds = this.peerManager.getAllPeerIds();
      peerIds.forEach(peerId => this.peerManager.removePeer(peerId));
      
      // Cleanup MediaSoup resources
      await this.mediasoupService.cleanup();
      
      // Close Socket.io server
      this.io.close();
      
      // Close HTTP server
      this.httpServer.close();
      
      console.info("Cleanup completed");
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  }
}

// Initialize and start the server
const server = new WebRTCServer();
server.start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});

export { WebRTCServer }; 