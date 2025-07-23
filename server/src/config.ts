import type { types } from "mediasoup";

export const config = {
  listenIp: "0.0.0.0",
  listenPort: 3001,
  rtpPlayer: {
    listenIp: "127.0.0.1",
    videoPort: 5004,
    audioPort: 5006,
    videoPort2: 5008,
    audioPort2: 5010,
  },
  mediasoup: {
    worker: {
      logLevel: "warn" as types.WorkerLogLevel,
      logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
    },
    router: {
      mediaCodecs: [
        {
          kind: "audio",
          mimeType: "audio/opus",
          clockRate: 48000,
          channels: 2,
          preferredPayloadType: 97,
        },
        {
          kind: "video",
          mimeType: "video/VP8",
          clockRate: 90000,
          preferredPayloadType: 96,
          parameters: {
            "x-google-start-bitrate": 1000,
          },
        },
      ] as types.RtpCodecCapability[],
    },
    webRtcTransport: {
      listenIps: [
        {
          ip: process.env.WEBRTC_LISTEN_IP || "127.0.0.1",
          announcedIp: process.env.WEBRTC_ANNOUNCED_IP || undefined,
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    },
  },
};
