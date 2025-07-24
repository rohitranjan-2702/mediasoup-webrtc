import * as mediasoup from "mediasoup";
import type { types } from "mediasoup";
import { config } from "../config";
import type { RtpTransportConfig } from "../types";

export class MediasoupService {
  private worker: types.Worker | null = null;
  private router: types.Router | null = null;
  private rtpTransports: RtpTransportConfig = {
    videoTransports: [],
    audioTransports: [],
  };

  public async initialize(): Promise<void> {
    await this.createWorker();
    await this.createRouter();
    await this.initializeRtpTransports();
  }

  public getRouter(): types.Router {
    if (!this.router) {
      throw new Error("Router not initialized");
    }
    return this.router;
  }

  public getRtpCapabilities(): types.RtpCapabilities {
    return this.getRouter().rtpCapabilities;
  }

  public async createWebRtcTransport(): Promise<types.WebRtcTransport> {
    return await this.getRouter().createWebRtcTransport(
      config.mediasoup.webRtcTransport
    );
  }

  public canConsume(params: {
    producerId: string;
    rtpCapabilities: types.RtpCapabilities;
  }): boolean {
    return this.getRouter().canConsume(params);
  }

  public async createRtpConsumer(
    producer: types.Producer,
    transportIndex: number
  ): Promise<types.Consumer | null> {
    try {
      const rtpTransports =
        producer.kind === "video"
          ? this.rtpTransports.videoTransports
          : this.rtpTransports.audioTransports;
      
      const rtpTransport = rtpTransports[transportIndex];

      if (!rtpTransport) {
        console.error(
          `No RTP transport available for ${producer.kind} at index ${transportIndex}`
        );
        return null;
      }

      const consumer = await rtpTransport.consume({
        producerId: producer.id,
        rtpCapabilities: this.getRtpCapabilities(),
      });

      this.logConsumerCreation(producer, consumer, transportIndex);
      this.setupConsumerEventHandlers(consumer, producer.id);

      return consumer;
    } catch (error) {
      console.error(
        `Failed to create RTP consumer for ${producer.kind}:`,
        error
      );
      return null;
    }
  }

  public async cleanup(): Promise<void> {
    console.info("Cleaning up MediaSoup resources...");
    
    // Close all RTP transports
    [...this.rtpTransports.videoTransports, ...this.rtpTransports.audioTransports]
      .forEach(transport => transport.close());
    
    // Close router
    if (this.router) {
      this.router.close();
      this.router = null;
    }

    // Close worker
    if (this.worker) {
      this.worker.close();
      this.worker = null;
    }
  }

  private async createWorker(): Promise<void> {
    this.worker = await mediasoup.createWorker({
      logLevel: config.mediasoup.worker.logLevel,
      logTags: config.mediasoup.worker.logTags as types.WorkerLogTag[],
      rtcMinPort: config.mediasoup.worker.rtcMinPort,
      rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
    });

    this.worker.on("died", () => {
      console.error("MediaSoup worker has died");
      setTimeout(() => process.exit(1), 2000);
    });

    console.info("MediaSoup worker created");
  }

  private async createRouter(): Promise<void> {
    if (!this.worker) {
      throw new Error("Worker not initialized");
    }

    this.router = await this.worker.createRouter({
      mediaCodecs: config.mediasoup.router.mediaCodecs,
    });

    console.info("MediaSoup router created");
  }

  private async initializeRtpTransports(): Promise<void> {
    try {
      await this.createVideoTransports();
      await this.createAudioTransports();
      console.log("All RTP transports initialized successfully");
    } catch (error) {
      console.error("Failed to initialize RTP transports:", error);
      throw error;
    }
  }

  private async createVideoTransports(): Promise<void> {
    // Video transport 1 (port 5004)
    const videoTransport1 = await this.createAndConnectPlainTransport(
      config.rtpPlayer.videoPort
    );
    this.rtpTransports.videoTransports.push(videoTransport1);
    console.log(`Video RTP transport 1 connected on port ${config.rtpPlayer.videoPort}`);

    // Video transport 2 (port 5008)
    const videoTransport2 = await this.createAndConnectPlainTransport(
      config.rtpPlayer.videoPort2
    );
    this.rtpTransports.videoTransports.push(videoTransport2);
    console.log(`Video RTP transport 2 connected on port ${config.rtpPlayer.videoPort2}`);
  }

  private async createAudioTransports(): Promise<void> {
    // Audio transport 1 (port 5006)
    const audioTransport1 = await this.createAndConnectPlainTransport(
      config.rtpPlayer.audioPort
    );
    this.rtpTransports.audioTransports.push(audioTransport1);
    console.log(`Audio RTP transport 1 connected on port ${config.rtpPlayer.audioPort}`);

    // Audio transport 2 (port 5010)
    const audioTransport2 = await this.createAndConnectPlainTransport(
      config.rtpPlayer.audioPort2
    );
    this.rtpTransports.audioTransports.push(audioTransport2);
    console.log(`Audio RTP transport 2 connected on port ${config.rtpPlayer.audioPort2}`);
  }

  private async createAndConnectPlainTransport(port: number): Promise<types.PlainTransport> {
    const transport = await this.getRouter().createPlainTransport({
      listenIp: config.rtpPlayer.listenIp,
      rtcpMux: false,
      comedia: false,
    });

    await transport.connect({
      ip: config.rtpPlayer.listenIp,
      port: port,
      rtcpPort: port + 1,
    });

    return transport;
  }

  private logConsumerCreation(
    producer: types.Producer,
    consumer: types.Consumer,
    transportIndex: number
  ): void {
    const ports =
      producer.kind === "video"
        ? [config.rtpPlayer.videoPort, config.rtpPlayer.videoPort2]
        : [config.rtpPlayer.audioPort, config.rtpPlayer.audioPort2];

    console.log(`Created RTP consumer for ${producer.kind}:`, {
      producerId: producer.id,
      consumerId: consumer.id,
      transportIndex: transportIndex,
      port: ports[transportIndex],
      payloadType: consumer.rtpParameters.codecs[0]?.payloadType,
    });
  }

  private setupConsumerEventHandlers(consumer: types.Consumer, producerId: string): void {
    consumer.on("transportclose", () => {
      console.log(`RTP consumer closed for producer ${producerId}`);
    });

    consumer.on("producerclose", () => {
      console.log(`RTP consumer closed due to producer close for ${producerId}`);
    });
  }
} 