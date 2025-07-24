"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";

// Constants
const HLS_CONFIG = {
  enableWorker: true,
  lowLatencyMode: true,
  backBufferLength: 90,
  maxBufferLength: 30,
  maxMaxBufferLength: 600,
} as const;

const RECOVERY_TIMEOUT = 2000;
const FALLBACK_RECOVERY_TIMEOUT = 3000;

// Types
interface VideoState {
  isLoading: boolean;
  isPlaying: boolean;
  isRecovering: boolean;
  error: string | null;
}

// Custom hook for buffer recovery logic
function useBufferRecovery(videoRef: React.RefObject<HTMLVideoElement | null>) {
  const [isRecovering, setIsRecovering] = useState(false);
  const recoveryTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleBufferStall = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    console.log("Buffer stalled, attempting recovery...");
    setIsRecovering(true);
    
    // Pause the video to allow buffer to recover
    video.pause();
    
    // Clear any existing recovery timeout
    if (recoveryTimeoutRef.current) {
      clearTimeout(recoveryTimeoutRef.current);
    }
    
    // Wait for recovery then try to resume
    recoveryTimeoutRef.current = setTimeout(() => {
      if (video && !video.paused) return; // Already resumed
      
      console.log("Attempting to resume playback after buffer recovery");
      video.play()
        .then(() => {
          setIsRecovering(false);
          console.log("Playback resumed successfully");
        })
        .catch((err) => {
          console.error("Failed to resume playback:", err);
          setIsRecovering(false);
          // Try one more time after a longer delay
          setTimeout(() => {
            video.play().catch(() => {
              throw new Error("Unable to recover from buffer stall");
            });
          }, FALLBACK_RECOVERY_TIMEOUT);
        });
    }, RECOVERY_TIMEOUT);
  }, [videoRef]);

  const clearRecovery = useCallback(() => {
    setIsRecovering(false);
    if (recoveryTimeoutRef.current) {
      clearTimeout(recoveryTimeoutRef.current);
      recoveryTimeoutRef.current = null;
    }
  }, []);

  return { isRecovering, handleBufferStall, clearRecovery };
}

// Custom hook for HLS player management
function useHLSPlayer(hlsUrl: string, videoRef: React.RefObject<HTMLVideoElement | null>) {
  const hlsRef = useRef<Hls | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const { isRecovering, handleBufferStall, clearRecovery } = useBufferRecovery(videoRef);

  const handleHLSError = useCallback((data: any) => {
    console.error("HLS error:", data);
    
    // Handle specific error types
    if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
      handleBufferStall();
      return; // Don't show error UI for buffer stalls
    }
    
    // Handle other recoverable errors
    if (data.fatal) {
      const hls = hlsRef.current;
      if (!hls) return;

      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          console.log("Fatal network error, trying to recover...");
          hls.startLoad();
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          console.log("Fatal media error, trying to recover...");
          hls.recoverMediaError();
          break;
        default:
          setError(`Fatal HLS Error: ${data.details}`);
          setIsLoading(false);
          break;
      }
    } else {
      // Non-fatal errors, just log them
      console.warn("Non-fatal HLS error:", data.details);
    }
  }, [handleBufferStall]);

  const initializeHLS = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      // HLS.js is supported, use it for HLS playback
      const hls = new Hls(HLS_CONFIG);
      hlsRef.current = hls;

      hls.loadSource(hlsUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log("HLS manifest parsed successfully");
        setIsLoading(false);
        setError(null);
      });

      hls.on(Hls.Events.ERROR, (event, data) => handleHLSError(data));

      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        console.log("HLS media attached");
      });

      // Listen for buffer events to provide better feedback
      hls.on(Hls.Events.BUFFER_APPENDED, () => {
        if (isRecovering) {
          console.log("Buffer recovered, content available");
        }
      });

    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native HLS support (Safari/iOS)
      console.log("Using native HLS support");
      video.src = hlsUrl;
      setIsLoading(false);
      setError(null);
    } else {
      setError("HLS is not supported in this browser");
      setIsLoading(false);
    }
  }, [hlsUrl, videoRef, handleHLSError, isRecovering]);

  const refreshStream = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    setIsLoading(true);
    setError(null);
    clearRecovery();

    if (hlsRef.current) {
      hlsRef.current.loadSource(hlsUrl);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.load();
    }
  }, [hlsUrl, videoRef, clearRecovery]);

  const cleanup = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    clearRecovery();
  }, [clearRecovery]);

  return {
    isLoading,
    error,
    isRecovering,
    handleBufferStall,
    initializeHLS,
    refreshStream,
    cleanup,
  };
}

// Custom hook for video state management
function useVideoState(
  videoRef: React.RefObject<HTMLVideoElement | null>, 
  handleBufferStall: () => void
) {
  const [isPlaying, setIsPlaying] = useState(false);

  const setupVideoEventListeners = useCallback(() => {
    const video = videoRef.current;
    if (!video) return () => {};

    const handleLoadStart = () => {
      // Loading state is managed by useHLSPlayer
    };
    const handleCanPlay = () => {
      // Loading state is managed by useHLSPlayer
    };
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleError = () => {
      // Error state is managed by useHLSPlayer
      console.log("Video element error occurred");
    };

    // Handle waiting event for buffer stalls in native HLS
    const handleWaiting = () => {
      if (!Hls.isSupported()) {
        console.log("Native HLS buffer stall detected");
        handleBufferStall();
      }
    };

    video.addEventListener("loadstart", handleLoadStart);
    video.addEventListener("canplay", handleCanPlay);
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("error", handleError);
    video.addEventListener("waiting", handleWaiting);

    return () => {
      video.removeEventListener("loadstart", handleLoadStart);
      video.removeEventListener("canplay", handleCanPlay);
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("error", handleError);
      video.removeEventListener("waiting", handleWaiting);
    };
  }, [videoRef, handleBufferStall]);

  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      video.play();
    } else {
      video.pause();
    }
  }, [videoRef]);

  return { isPlaying, setupVideoEventListeners, togglePlayPause };
}

// Video Player Component
interface VideoPlayerProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isLoading: boolean;
  isRecovering: boolean;
  error: string | null;
}

function VideoPlayer({ videoRef, isLoading, isRecovering, error }: VideoPlayerProps) {
  return (
    <div className="relative w-full max-w-4xl">
      <video
        ref={videoRef}
        className="w-full h-auto border-2 border-gray-300 rounded-lg shadow-lg"
        controls
        autoPlay
        muted
        playsInline
      />

      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 rounded-lg">
          <div className="text-white text-lg">Loading stream...</div>
        </div>
      )}

      {isRecovering && (
        <div className="absolute inset-0 flex items-center justify-center bg-blue-500 bg-opacity-75 rounded-lg">
          <div className="text-white text-center p-4">
            <div className="text-lg font-semibold mb-2">🔄 Recovering</div>
            <div className="text-sm">Buffer stalled, waiting for recovery...</div>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-500 bg-opacity-75 rounded-lg">
          <div className="text-white text-center p-4">
            <div className="text-lg font-semibold mb-2">Error</div>
            <div className="text-sm">{error}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// Player Controls Component
interface PlayerControlsProps {
  isPlaying: boolean;
  onPlayPause: () => void;
  onRefresh: () => void;
  disabled: boolean;
}

function PlayerControls({ isPlaying, onPlayPause, onRefresh, disabled }: PlayerControlsProps) {
  return (
    <div className="flex gap-4">
      <button
        onClick={onPlayPause}
        className={`px-6 py-2 rounded-lg text-white font-medium ${
          isPlaying
            ? "bg-red-500 hover:bg-red-600"
            : "bg-green-500 hover:bg-green-600"
        }`}
        disabled={disabled}
      >
        {isPlaying ? "⏸️ Pause" : "▶️ Play"}
      </button>

      <button
        onClick={onRefresh}
        className="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white font-medium rounded-lg"
      >
        🔄 Refresh Stream
      </button>
    </div>
  );
}

// Stream Info Component
interface StreamInfoProps {
  hlsUrl: string;
  isRecovering: boolean;
}

function StreamInfo({ hlsUrl, isRecovering }: StreamInfoProps) {
  return (
    <div className="text-sm text-gray-600 text-center max-w-2xl">
      <p>
        Stream URL:{" "}
        <code className="bg-gray-100 px-2 py-1 rounded">{hlsUrl}</code>
      </p>
      {Hls.isSupported() ? (
        <p className="mt-2 text-green-600">✅ HLS.js supported</p>
      ) : (
        <p className="mt-2 text-orange-600">⚠️ Using native HLS support</p>
      )}
      {isRecovering && (
        <p className="mt-2 text-blue-600">🔄 Recovering from buffer stall...</p>
      )}
    </div>
  );
}

// Main Watch Page Component
export default function WatchPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsUrl = "/live/stream.m3u8";

  const {
    isLoading,
    error,
    isRecovering,
    handleBufferStall,
    initializeHLS,
    refreshStream,
    cleanup,
  } = useHLSPlayer(hlsUrl, videoRef);

  const { isPlaying, setupVideoEventListeners, togglePlayPause } = useVideoState(
    videoRef,
    handleBufferStall
  );

  useEffect(() => {
    initializeHLS();
    const cleanupVideoListeners = setupVideoEventListeners();

    return () => {
      cleanup();
      cleanupVideoListeners();
    };
  }, [initializeHLS, setupVideoEventListeners, cleanup]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-6 p-8">
      <h1 className="text-3xl font-bold text-gray-800">HLS Live Stream</h1>

      <VideoPlayer
        videoRef={videoRef}
        isLoading={isLoading}
        isRecovering={isRecovering}
        error={error}
      />

      <PlayerControls
        isPlaying={isPlaying}
        onPlayPause={togglePlayPause}
        onRefresh={refreshStream}
        disabled={!!error}
      />

      <StreamInfo hlsUrl={hlsUrl} isRecovering={isRecovering} />
    </div>
  );
}
