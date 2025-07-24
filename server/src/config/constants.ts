// Port configuration constants
export const PORTS = {
  VIDEO: {
    FIRST: 5004,
    SECOND: 5008,
  },
  AUDIO: {
    FIRST: 5006,
    SECOND: 5010,
  },
  RTC: {
    MIN: 40000,
    MAX: 49999,
  },
} as const;

// FFmpeg configuration constants
export const FFMPEG = {
  VIDEO: {
    SCALE: "320:240",
    GOP_SIZE: 30,
    PRESET: "veryfast",
    TUNE: "zerolatency",
    PIX_FMT: "yuv420p",
  },
  AUDIO: {
    SAMPLE_RATE: 44100,
    CHANNELS: 2,
    BITRATE: "128k",
  },
  HLS: {
    TIME: 2,
    LIST_SIZE: 5,
    SEGMENT_TYPE: "mpegts",
  },
  ANALYSIS: {
    DURATION: 3000000,
    PROBE_SIZE: 3000000,
    MAX_DELAY: 500000,
    BUFFER_SIZE: 65536,
  },
} as const;

// MediaSoup codec configuration
export const CODECS = {
  OPUS: {
    PAYLOAD_TYPE: 97,
    CLOCK_RATE: 48000,
    CHANNELS: 2,
  },
  VP8: {
    PAYLOAD_TYPE: 96,
    CLOCK_RATE: 90000,
    START_BITRATE: 1000,
  },
} as const; 