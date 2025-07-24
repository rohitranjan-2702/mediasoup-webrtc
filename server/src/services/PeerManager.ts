import type { types } from "mediasoup";
import type { Peer, ProducerInfo } from "../types";

export class PeerManager {
  private peers = new Map<string, Peer>();
  private producerAssignments = new Map<string, number>(); // producerId -> transportIndex

  public addPeer(socketId: string): void {
    this.peers.set(socketId, {
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
    });
    console.info("Peer added:", socketId);
  }

  public removePeer(socketId: string): void {
    const peer = this.peers.get(socketId);
    if (peer) {
      this.cleanupPeerResources(peer);
      this.peers.delete(socketId);
      console.info("Peer removed:", socketId);
    }
  }

  public getPeer(socketId: string): Peer | undefined {
    return this.peers.get(socketId);
  }

  public addTransport(socketId: string, transport: types.WebRtcTransport): void {
    const peer = this.getPeer(socketId);
    if (peer) {
      peer.transports.set(transport.id, transport);
      this.setupTransportEventHandlers(transport, socketId);
    }
  }

  public getTransport(socketId: string, transportId: string): types.WebRtcTransport | undefined {
    const peer = this.getPeer(socketId);
    return peer?.transports.get(transportId);
  }

  public addProducer(socketId: string, producer: types.Producer): void {
    const peer = this.getPeer(socketId);
    if (peer) {
      peer.producers.set(producer.id, producer);
      this.setupProducerEventHandlers(producer, socketId);
    }
  }

  public getProducer(producerId: string): types.Producer | undefined {
    for (const peer of this.peers.values()) {
      const producer = peer.producers.get(producerId);
      if (producer) return producer;
    }
    return undefined;
  }

  public addConsumer(socketId: string, consumer: types.Consumer): void {
    const peer = this.getPeer(socketId);
    if (peer) {
      peer.consumers.set(consumer.id, consumer);
      this.setupConsumerEventHandlers(consumer, socketId);
    }
  }

  public getConsumer(socketId: string, consumerId: string): types.Consumer | undefined {
    const peer = this.getPeer(socketId);
    return peer?.consumers.get(consumerId);
  }

  public getExistingProducers(excludeSocketId?: string): ProducerInfo[] {
    const producers: ProducerInfo[] = [];
    
    for (const [socketId, peer] of this.peers.entries()) {
      if (socketId !== excludeSocketId) {
        for (const [producerId] of peer.producers) {
          producers.push({ producerId, socketId });
        }
      }
    }
    
    return producers;
  }

  public getProducerTransportIndex(socketId: string): number {
    const peerIds = Array.from(this.peers.keys());
    const peerIndex = peerIds.indexOf(socketId);
    
    if (peerIndex === -1 || peerIndex > 1) {
      console.error(`Invalid peer index ${peerIndex} for peer ${socketId}`);
      return -1;
    }
    
    return peerIndex;
  }

  public setProducerAssignment(producerId: string, transportIndex: number): void {
    this.producerAssignments.set(producerId, transportIndex);
  }

  public getProducerAssignment(producerId: string): number | undefined {
    return this.producerAssignments.get(producerId);
  }

  public removeProducerAssignment(producerId: string): void {
    this.producerAssignments.delete(producerId);
  }

  public getAllPeerIds(): string[] {
    return Array.from(this.peers.keys());
  }

  public getPeerCount(): number {
    return this.peers.size;
  }

  private cleanupPeerResources(peer: Peer): void {
    // Close all transports
    peer.transports.forEach((transport) => {
      try {
        transport.close();
      } catch (error) {
        console.error("Error closing transport:", error);
      }
    });

    // Close all producers and remove assignments
    peer.producers.forEach((producer) => {
      try {
        this.removeProducerAssignment(producer.id);
        producer.close();
      } catch (error) {
        console.error("Error closing producer:", error);
      }
    });

    // Close all consumers
    peer.consumers.forEach((consumer) => {
      try {
        consumer.close();
      } catch (error) {
        console.error("Error closing consumer:", error);
      }
    });

    // Clear all maps
    peer.transports.clear();
    peer.producers.clear();
    peer.consumers.clear();
  }

  private setupTransportEventHandlers(transport: types.WebRtcTransport, socketId: string): void {
    transport.on("dtlsstatechange", (dtlsState: string) => {
      if (dtlsState === "closed") {
        transport.close();
        const peer = this.getPeer(socketId);
        if (peer) {
          peer.transports.delete(transport.id);
        }
      }
    });
  }

  private setupProducerEventHandlers(producer: types.Producer, socketId: string): void {
    producer.on("transportclose", () => {
      producer.close();
      const peer = this.getPeer(socketId);
      if (peer) {
        peer.producers.delete(producer.id);
        this.removeProducerAssignment(producer.id);
      }
    });
  }

  private setupConsumerEventHandlers(consumer: types.Consumer, socketId: string): void {
    consumer.on("transportclose", () => {
      consumer.close();
      const peer = this.getPeer(socketId);
      if (peer) {
        peer.consumers.delete(consumer.id);
      }
    });

    consumer.on("producerclose", () => {
      consumer.close();
      const peer = this.getPeer(socketId);
      if (peer) {
        peer.consumers.delete(consumer.id);
      }
    });
  }
} 