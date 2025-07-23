"use client";

import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import * as mediasoupClient from "mediasoup-client";
import { types } from "mediasoup-client";

export default function StreamPage() {
  // Refs and State
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [device, setDevice] = useState<types.Device | null>(null);

  const [remoteStreams, setRemoteStreams] = useState<
    { id: string; stream: MediaStream; kind: string }[]
  >([]);

  // Track which producers we're already consuming to prevent duplicates
  const [consumingProducers, setConsumingProducers] = useState<Set<string>>(
    new Set()
  );

  // Camera and microphone state
  const [isCameraOn, setIsCameraOn] = useState(true);
  const [isMicOn, setIsMicOn] = useState(true);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [videoProducer, setVideoProducer] = useState<types.Producer | null>(
    null
  );
  const [audioProducer, setAudioProducer] = useState<types.Producer | null>(
    null
  );

  /**
   * Main function to connect to the server and start producing video.
   */
  const connectAndProduce = async () => {
    if (socket) {
      console.warn("Already connected.");
      return;
    }

    // --- 1. Connect to the signaling server ---
    const socketIo = io("http://localhost:3001");

    socketIo.on("connect", async () => {
      console.log("Connected to signaling server with ID:", socketIo.id);
      setSocket(socketIo);

      // --- 2. Get Router RTP Capabilities & Create Device ---
      socketIo.emit(
        "getRouterRtpCapabilities",
        async (rtpCapabilities: types.RtpCapabilities) => {
          console.log("Got Router RTP Capabilities.");
          try {
            const newDevice = new mediasoupClient.Device();
            await newDevice.load({ routerRtpCapabilities: rtpCapabilities });
            setDevice(newDevice);

            // --- 3. Create a "Send" Transport ---
            createSendTransport(socketIo, newDevice);
          } catch (error) {
            console.error("Failed to load device:", error);
          }
        }
      );
    });
  };

  /**
   * Creates the client-side transport for sending media.
   */
  const createSendTransport = (
    socketInstance: Socket,
    deviceInstance: types.Device
  ) => {
    socketInstance.emit(
      "createWebRtcTransport",
      { isSender: true },
      async (serverTransportOptions: types.TransportOptions) => {
        console.log("Server transport options received.");
        const transport = deviceInstance.createSendTransport(
          serverTransportOptions
        );

        // Event: 'connect' - fired when the transport is successfully connected
        transport.on(
          "connect",
          async ({ dtlsParameters }, callback, errback) => {
            console.log('Transport "connect" event');
            socketInstance.emit(
              "connectWebRtcTransport",
              { transportId: transport.id, dtlsParameters },
              () => {
                callback();
              }
            );
          }
        );

        // Event: 'produce' - fired when a new track is ready to be sent
        transport.on(
          "produce",
          async ({ kind, rtpParameters }, callback, errback) => {
            console.log(`Transport "produce" event for kind: ${kind}`);
            socketInstance.emit(
              "produce",
              { transportId: transport.id, kind, rtpParameters },
              ({ id }: { id: string }) => {
                callback({ id });
              }
            );
          }
        );

        // After creating the transport, get media and produce
        startProducing(transport);
      }
    );
  };

  /**
   * Gets user media and starts the producer.
   */
  const startProducing = async (transport: types.Transport) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });

      setLocalStream(stream);

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];

      const vProducer = await transport.produce({ track: videoTrack });
      const aProducer = await transport.produce({ track: audioTrack });

      // Store producers in state for later control
      setVideoProducer(vProducer);
      setAudioProducer(aProducer);

      console.log("Produced video and audio tracks", transport.id);

      return { videoProducer: vProducer, audioProducer: aProducer };
    } catch (error) {
      console.error("Failed to get user media or produce:", error);
    }
  };

  /**
   * Toggle camera on/off
   */
  const toggleCamera = () => {
    if (!localStream || !videoProducer) return;

    const videoTrack = localStream.getVideoTracks()[0];
    if (!videoTrack) return;

    if (isCameraOn) {
      // Turn off camera
      videoTrack.enabled = false;
      videoProducer.pause();
      setIsCameraOn(false);
    } else {
      // Turn on camera
      videoTrack.enabled = true;
      videoProducer.resume();
      setIsCameraOn(true);
    }
  };

  /**
   * Toggle microphone on/off
   */
  const toggleMicrophone = () => {
    if (!localStream || !audioProducer) return;

    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) return;

    if (isMicOn) {
      // Turn off microphone
      audioTrack.enabled = false;
      audioProducer.pause();
      setIsMicOn(false);
    } else {
      // Turn on microphone
      audioTrack.enabled = true;
      audioProducer.resume();
      setIsMicOn(true);
    }
  };

  const consume = (producerId: string, remoteSocketId: string) => {
    console.log("consume", producerId, remoteSocketId);
    if (!device) return;
    if (!socket) return;

    // Check if we're already consuming this producer
    if (consumingProducers.has(producerId)) {
      console.log("Already consuming producer:", producerId);
      return;
    }

    // Mark this producer as being consumed
    setConsumingProducers((prev) => new Set([...prev, producerId]));
    socket.emit(
      "createWebRtcTransport",
      { isSender: false },
      async (serverTransportOptions: types.TransportOptions) => {
        const recvTransport = device.createRecvTransport(
          serverTransportOptions
        );

        recvTransport.on("connect", ({ dtlsParameters }, callback) => {
          socket.emit(
            "connectWebRtcTransport",
            { transportId: recvTransport.id, dtlsParameters },
            callback
          );
        });

        socket.emit(
          "consume",
          {
            rtpCapabilities: device.rtpCapabilities,
            transportId: recvTransport.id,
            producerId,
          },
          async (data: {
            id: string;
            producerId: string;
            kind: string;
            rtpParameters: types.RtpParameters;
            error?: string;
          }) => {
            if (data.error) {
              console.error("Consume error", data.error);
              // Remove from consuming set on error
              setConsumingProducers((prev) => {
                const newSet = new Set(prev);
                newSet.delete(producerId);
                return newSet;
              });
              return;
            }

            try {
              const consumer = await recvTransport.consume({
                id: data.id,
                producerId: data.producerId,
                kind: data.kind as "video" | "audio",
                rtpParameters: data.rtpParameters,
              });

              // Resume the consumer
              socket.emit("resume", { consumerId: consumer.id }, () => {});

              // Attach to video/audio
              const stream = new MediaStream([consumer.track]);
              const streamId = `${remoteSocketId}-${data.kind}`;

              setRemoteStreams((prev) => {
                // More robust duplicate check - check by stream ID
                const existingIndex = prev.findIndex(
                  (item) => item.id === streamId
                );
                if (existingIndex !== -1) {
                  // Replace existing stream instead of ignoring
                  const newStreams = [...prev];
                  newStreams[existingIndex] = {
                    id: streamId,
                    stream,
                    kind: data.kind,
                  };
                  return newStreams;
                }

                // Add new stream
                return [
                  ...prev,
                  {
                    id: streamId,
                    stream,
                    kind: data.kind,
                  },
                ];
              });
              console.log(
                "Consumed track",
                data.kind,
                "for producer",
                producerId
              );
            } catch (error) {
              console.error("Failed to consume track:", error);
              // Remove from consuming set on error
              setConsumingProducers((prev) => {
                const newSet = new Set(prev);
                newSet.delete(producerId);
                return newSet;
              });
            }
          }
        );
      }
    );
  };

  useEffect(() => {
    if (!socket) return;
    console.log(socket.id);

    const handleExistingProducers = (
      producers: { producerId: string; socketId: string }[]
    ) => {
      console.log("existingProducers", producers);
      producers.forEach(({ producerId, socketId }) => {
        if (socketId === socket.id) return;
        consume(producerId, socketId);
      });
    };

    const handleNewProducer = ({
      producerId,
      socketId,
    }: {
      producerId: string;
      socketId: string;
    }) => {
      console.log("new-producer", producerId, socketId);
      consume(producerId, socketId);
    };

    // Handle producer removal (when a peer disconnects)
    const handleProducerClosed = ({
      producerId,
      socketId,
    }: {
      producerId: string;
      socketId: string;
    }) => {
      console.log("Producer closed:", producerId, socketId);
      // Remove from consuming producers
      setConsumingProducers((prev) => {
        const newSet = new Set(prev);
        newSet.delete(producerId);
        return newSet;
      });
      // Remove related streams
      setRemoteStreams((prev) =>
        prev.filter((stream) => !stream.id.startsWith(socketId + "-"))
      );
    };

    socket.on("existingProducers", handleExistingProducers);
    socket.on("new-producer", handleNewProducer);
    socket.on("producer-closed", handleProducerClosed);

    // Cleanup function to remove listeners
    return () => {
      socket.off("existingProducers", handleExistingProducers);
      socket.off("new-producer", handleNewProducer);
      socket.off("producer-closed", handleProducerClosed);
    };
  }, [socket, device]); // Adding device as dependency since consume() uses it

  // Clean up when socket disconnects
  useEffect(() => {
    if (!socket) {
      // Reset all state when socket is disconnected
      setRemoteStreams([]);
      setConsumingProducers(new Set());
      setLocalStream(null);
      setVideoProducer(null);
      setAudioProducer(null);
      setIsCameraOn(true);
      setIsMicOn(true);
    }
  }, [socket]);

  return (
    <div className="flex flex-col items-center justify-center h-screen gap-4">
      <h1 className="text-2xl font-bold">Stream Your Video</h1>
      <button
        className="bg-blue-500 text-white p-2 rounded-md cursor-pointer"
        onClick={connectAndProduce}
        disabled={!!socket}
      >
        Connect and Start Streaming
      </button>

      {/* Camera and Microphone Controls */}
      {socket && localStream && (
        <div className="flex gap-4">
          <button
            className={`p-2 rounded-md text-white cursor-pointer ${
              isCameraOn
                ? "bg-green-500 hover:bg-green-600"
                : "bg-red-500 hover:bg-red-600"
            }`}
            onClick={toggleCamera}
          >
            {isCameraOn ? "📹 Camera On" : "📹 Camera Off"}
          </button>
          <button
            className={`p-2 rounded-md text-white cursor-pointer ${
              isMicOn
                ? "bg-green-500 hover:bg-green-600"
                : "bg-red-500 hover:bg-red-600"
            }`}
            onClick={toggleMicrophone}
          >
            {isMicOn ? "🎤 Mic On" : "🎤 Mic Off"}
          </button>
        </div>
      )}

      <div className="flex flex-row items-center justify-center gap-4">
        <div>
          <h3 className="text-2xl font-bold text-blue-600">
            My Video {socket?.id}
          </h3>
          <video
            ref={localVideoRef}
            autoPlay
            muted
            style={{ width: "400px", border: "2px solid blue" }}
          />
        </div>
        {remoteStreams.map(({ id, stream, kind }) =>
          kind === "video" ? (
            <div
              key={id}
              className="flex flex-col items-center justify-center gap-4"
            >
              <h3 className="text-2xl font-bold text-green-500">
                Remote Video {id}
              </h3>
              <video
                autoPlay
                style={{ width: "300px", border: "2px solid green" }}
                ref={(el) => {
                  if (el) el.srcObject = stream;
                }}
              />
            </div>
          ) : (
            <audio
              key={id}
              autoPlay
              ref={(el) => {
                if (el) el.srcObject = stream;
              }}
              style={{ display: "none" }}
            />
          )
        )}
      </div>
    </div>
  );
}
