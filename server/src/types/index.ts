import type { types } from "mediasoup";
import type { ChildProcess } from "child_process";

export interface Peer {
  transports: Map<string, types.WebRtcTransport>;
  producers: Map<string, types.Producer>;
  consumers: Map<string, types.Consumer>;
}

export interface SocketEventPayloads {
  createWebRtcTransport: {
    isSender: boolean;
  };
  connectWebRtcTransport: {
    transportId: string;
    dtlsParameters: types.DtlsParameters;
  };
  produce: {
    transportId: string;
    kind: string;
    rtpParameters: types.RtpParameters;
  };
  consume: {
    transportId: string;
    producerId: string;
    rtpCapabilities: types.RtpCapabilities;
  };
  resume: {
    consumerId: string;
  };
}

export interface ProducerInfo {
  producerId: string;
  socketId: string;
}

export interface TransportInfo {
  id: string;
  iceParameters: types.IceParameters;
  iceCandidates: types.IceCandidate[];
  dtlsParameters: types.DtlsParameters;
}

export interface ConsumerInfo {
  id: string;
  producerId: string;
  kind: types.MediaKind;
  rtpParameters: types.RtpParameters;
}

export interface FFmpegManager {
  process: ChildProcess | null;
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

export interface RtpTransportConfig {
  videoTransports: types.PlainTransport[];
  audioTransports: types.PlainTransport[];
} 