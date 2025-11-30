import {
  NostrClient,
  NostrKeyManager,
  Filter,
  EventKinds,
  TokenTransferProtocol,
} from "@unicitylabs/nostr-js-sdk";
import type { Event } from "@unicitylabs/nostr-js-sdk";
import type { Config } from "./config.js";

export interface PendingPayment {
  requestId: string;
  unicityId: string;
  userPubkey: string;
  amount: bigint;
  coinId: string;
  createdAt: number;
  resolve: (success: boolean) => void;
}

export class NostrService {
  private client: NostrClient;
  private keyManager: NostrKeyManager;
  private config: Config;
  private pendingPayments: Map<string, PendingPayment> = new Map();
  private connected = false;

  constructor(config: Config) {
    this.config = config;
    this.keyManager = NostrKeyManager.fromPrivateKeyHex(config.privateKeyHex);
    this.client = new NostrClient(this.keyManager);
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    await this.client.connect(this.config.relayUrl);
    this.connected = true;

    // Subscribe to incoming token transfers (payments to us)
    this.subscribeToPayments();

    console.error(`Connected to Nostr relay: ${this.config.relayUrl}`);
    console.error(`MCP pubkey: ${this.keyManager.getPublicKeyHex()}`);
  }

  private subscribeToPayments(): void {
    const myPubkey = this.keyManager.getPublicKeyHex();

    // Listen for token transfers addressed to us
    const filter = Filter.builder()
      .kinds(EventKinds.TOKEN_TRANSFER)
      .pTags(myPubkey)
      .build();

    this.client.subscribe(filter, {
      onEvent: (event: Event) => {
        this.handleIncomingTransfer(event).catch((err) => {
          console.error("Error handling incoming transfer:", err);
        });
      },
    });
  }

  private async handleIncomingTransfer(event: Event): Promise<void> {
    try {
      // Check if this is a valid token transfer
      if (!TokenTransferProtocol.isTokenTransfer(event)) {
        return;
      }

      const senderPubkey = TokenTransferProtocol.getSender(event);
      const amount = TokenTransferProtocol.getAmount(event);

      // Find matching pending payment
      for (const [key, pending] of this.pendingPayments) {
        if (
          pending.userPubkey === senderPubkey &&
          amount !== undefined &&
          amount >= pending.amount
        ) {
          console.error(`Payment confirmed for ${pending.unicityId}`);
          pending.resolve(true);
          this.pendingPayments.delete(key);
          return;
        }
      }
    } catch (err) {
      console.error("Error processing transfer:", err);
    }
  }

  async resolvePubkey(unicityId: string): Promise<string | null> {
    return this.client.queryPubkeyByNametag(unicityId);
  }

  async sendPaymentRequest(
    unicityId: string,
    userPubkey: string
  ): Promise<{ requestId: string; waitForPayment: () => Promise<boolean> }> {
    const requestId = crypto.randomUUID().slice(0, 8);

    await this.client.sendPaymentRequest(userPubkey, {
      amount: this.config.amount,
      coinId: this.config.coinId,
      recipientNametag: this.config.recipientNametag,
      message: `Gaming day pass for ${unicityId}`,
      requestId,
    });

    console.error(
      `Sent payment request ${requestId} to ${unicityId} for amount ${this.config.amount}`
    );

    // Create a promise that resolves when payment is received
    const waitForPayment = (): Promise<boolean> => {
      return new Promise((resolve) => {
        const pending: PendingPayment = {
          requestId,
          unicityId,
          userPubkey,
          amount: this.config.amount,
          coinId: this.config.coinId,
          createdAt: Date.now(),
          resolve,
        };

        this.pendingPayments.set(requestId, pending);

        // Timeout after configured seconds
        setTimeout(() => {
          if (this.pendingPayments.has(requestId)) {
            this.pendingPayments.delete(requestId);
            resolve(false);
          }
        }, this.config.paymentTimeoutSeconds * 1000);
      });
    };

    return { requestId, waitForPayment };
  }

  getPublicKey(): string {
    return this.keyManager.getPublicKeyHex();
  }

  disconnect(): void {
    this.client.disconnect();
    this.connected = false;
  }
}
