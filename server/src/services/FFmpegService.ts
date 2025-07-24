import { spawn, ChildProcess } from "child_process";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import type { FFmpegManager } from "../types";

export class FFmpegService implements FFmpegManager {
  public process: ChildProcess | null = null;
  private readonly outputDir: string;
  private readonly workingDir: string;

  constructor() {
    this.outputDir = path.resolve(__dirname, "../../../fermion-app/public/live");
    this.workingDir = path.resolve(__dirname, "..");
  }

  public start(): void {
    if (this.isRunning()) {
      console.warn("FFmpeg process is already running");
      return;
    }

    console.info("Starting FFmpeg process...");
    this.ensureOutputDirectory();

    const args = this.buildFFmpegArgs();
    this.process = spawn("ffmpeg", args, {
      cwd: this.workingDir,
    });

    this.setupEventHandlers();
  }

  public stop(): void {
    if (!this.process) {
      return;
    }

    console.info("Stopping FFmpeg process...");
    this.process.kill("SIGTERM");
    this.process = null;
  }

  public isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  private ensureOutputDirectory(): void {
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
      console.log(`Created output directory: ${this.outputDir}`);
    }
  }

  private buildFFmpegArgs(): string[] {
    return [
      "-protocol_whitelist",
      "file,udp,rtp",
      // FFmpeg flags for better RTP handling
      "-fflags",
      "+genpts+discardcorrupt+igndts",
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
      "[0:0]setpts=PTS-STARTPTS,scale=320:240[v0]; [0:2]setpts=PTS-STARTPTS,scale=320:240[v1]; [v0][v1]hstack=inputs=2[v]; [0:1][0:3]amerge=inputs=2[a]",
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
      "30",
      "-sc_threshold",
      "0",
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
      "append_list",
      "-hls_allow_cache",
      "0",
      "-hls_segment_type",
      "mpegts",
      path.resolve(this.outputDir, "stream.m3u8"),
    ];
  }

  private setupEventHandlers(): void {
    if (!this.process) return;

    this.process.stdout?.on("data", (data: Buffer) => {
      console.log(`FFmpeg stdout: ${data.toString()}`);
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      console.log(`FFmpeg stderr: ${data.toString()}`);
    });

    this.process.on("close", (code: number) => {
      console.log(`FFmpeg process exited with code ${code}`);
      this.process = null;
    });

    this.process.on("error", (error: Error) => {
      console.error("FFmpeg process error:", error);
      this.process = null;
    });
  }
} 