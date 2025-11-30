import {
  NostrClient,
  NostrKeyManager,
  Filter,
  EventKinds,
  TokenTransferProtocol,
} from "@unicitylabs/nostr-js-sdk";
import type { Event } from "@unicitylabs/nostr-js-sdk";
import type { Config } from "./config.js";
import type { IdentityService } from "./identity-service.js";

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
  private client: NostrClient | null = null;
  private keyManager: NostrKeyManager | null = null;
  private config: Config;
  private identityService: IdentityService;
  private pendingPayments: Map<string, PendingPayment> = new Map();
  private connected = false;

  constructor(config: Config, identityService: IdentityService) {
    this.config = config;
    this.identityService = identityService;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const identity = this.identityService.getIdentity();
    const secretKey = Buffer.from(identity.privateKeyHex, "hex");
    this.keyManager = NostrKeyManager.fromPrivateKey(secretKey);
    this.client = new NostrClient(this.keyManager);

    await this.client.connect(this.config.relayUrl);
    this.connected = true;

    // Subscribe to incoming token transfers (payments to us)
    this.subscribeToPayments();

    console.error(`Nostr service connected to: ${this.config.relayUrl}`);
    console.error(`MCP pubkey: ${this.keyManager.getPublicKeyHex()}`);
  }

  private subscribeToPayments(): void {
    if (!this.client || !this.keyManager) return;

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

    console.error("Subscribed to incoming token transfers");
  }

  private async handleIncomingTransfer(event: Event): Promise<void> {
    if (!this.keyManager) return;

    try {
      // Check if this is a valid token transfer
      if (!TokenTransferProtocol.isTokenTransfer(event)) {
        return;
      }

      const senderPubkey = TokenTransferProtocol.getSender(event);
      const amount = TokenTransferProtocol.getAmount(event);

      console.error(`Received token transfer from ${senderPubkey.slice(0, 16)}... amount=${amount}`);

      // Find matching pending payment
      for (const [key, pending] of this.pendingPayments) {
        if (
          pending.userPubkey === senderPubkey &&
          amount !== undefined &&
          amount >= pending.amount
        ) {
          console.error(`Payment confirmed for ${pending.unicityId}!`);
          pending.resolve(true);
          this.pendingPayments.delete(key);
          return;
        }
      }

      console.error("No matching pending payment found for this transfer");
    } catch (err) {
      console.error("Error processing transfer:", err);
    }
  }

  async resolvePubkey(unicityId: string): Promise<string | null> {
    if (!this.client) {
      throw new Error("Nostr client not connected");
    }
    const cleanId = unicityId.replace("@unicity", "").replace("@", "").trim();
    return this.client.queryPubkeyByNametag(cleanId);
  }

  async sendPaymentRequest(
    unicityId: string,
    userPubkey: string
  ): Promise<{ requestId: string; waitForPayment: () => Promise<boolean> }> {
    if (!this.client) {
      throw new Error("Nostr client not connected");
    }

    const requestId = Math.random().toString(36).substring(2, 10);

    await this.client.sendPaymentRequest(userPubkey, {
      amount: this.config.amount,
      coinId: this.config.coinId,
      recipientNametag: this.config.nametag,
      message: `Gaming day pass for @${unicityId}`,
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
    if (!this.keyManager) {
      throw new Error("Key manager not initialized");
    }
    return this.keyManager.getPublicKeyHex();
  }

  disconnect(): void {
    if (this.client) {
      this.client.disconnect();
    }
    this.connected = false;
  }
}
