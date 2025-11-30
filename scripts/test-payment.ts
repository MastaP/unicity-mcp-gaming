/**
 * E2E test script for payment flow debugging
 *
 * Usage: npx ts-node --esm scripts/test-payment.ts
 */

import "dotenv/config";
import {
  NostrClient,
  NostrKeyManager,
  Filter,
  EventKinds,
  TokenTransferProtocol,
} from "@unicitylabs/nostr-js-sdk";
import type { Event } from "@unicitylabs/nostr-js-sdk";
import { loadConfig } from "../src/config.js";

// Update path based on new rootDir


const TARGET_UNICITY_ID = "mp-9";

async function main() {
  const config = loadConfig();

  console.log("=== Payment Flow E2E Test ===");
  console.log(`Relay: ${config.relayUrl}`);
  console.log(`Target: @${TARGET_UNICITY_ID}`);
  console.log(`Amount: ${config.amount}`);
  console.log(`Coin ID: ${config.coinId}`);
  console.log(`Timeout: ${config.paymentTimeoutSeconds}s`);
  console.log("");

  // Load MCP identity
  const fs = await import("fs");
  const path = await import("path");
  const identityPath = path.join(config.dataDir, "identity.json");

  if (!fs.existsSync(identityPath)) {
    console.error(`Identity file not found: ${identityPath}`);
    console.error("Run the MCP server first to generate an identity.");
    process.exit(1);
  }

  const identityData = JSON.parse(fs.readFileSync(identityPath, "utf-8"));
  const secretKey = Buffer.from(identityData.privateKeyHex, "hex");
  const keyManager = NostrKeyManager.fromPrivateKey(secretKey);
  const client = new NostrClient(keyManager);

  console.log(`MCP pubkey: ${keyManager.getPublicKeyHex()}`);
  console.log("");

  // Connect
  console.log("Connecting to relay...");
  await client.connect(config.relayUrl);
  console.log("Connected!");
  console.log("");

  // Resolve target pubkey
  console.log(`Resolving @${TARGET_UNICITY_ID}...`);
  const targetPubkey = await client.queryPubkeyByNametag(TARGET_UNICITY_ID);

  if (!targetPubkey) {
    console.error(`Could not resolve @${TARGET_UNICITY_ID}`);
    client.disconnect();
    process.exit(1);
  }
  console.log(`Target pubkey: ${targetPubkey}`);
  console.log("");

  // Subscribe to incoming token transfers BEFORE sending payment request
  console.log("Subscribing to incoming token transfers...");
  const myPubkey = keyManager.getPublicKeyHex();

  const filter = Filter.builder()
    .kinds(EventKinds.TOKEN_TRANSFER)
    .pTags(myPubkey)
    .build();

  console.log("Filter:", JSON.stringify(filter, null, 2));
  console.log("");

  let paymentRequestEventId: string | null = null;

  client.subscribe(filter, {
    onEvent: (event: Event) => {
      console.log("");
      console.log("=== RECEIVED TOKEN TRANSFER EVENT ===");
      console.log(`Event ID: ${event.id}`);
      console.log(`Kind: ${event.kind}`);
      console.log(`Pubkey (sender envelope): ${event.pubkey}`);
      console.log(`Created at: ${new Date(event.created_at * 1000).toISOString()}`);
      console.log(`Tags:`, JSON.stringify(event.tags, null, 2));
      console.log(`Content length: ${event.content.length}`);
      console.log("");

      // Parse token transfer fields
      const isTransfer = TokenTransferProtocol.isTokenTransfer(event);
      console.log(`Is token transfer: ${isTransfer}`);

      if (isTransfer) {
        const sender = TokenTransferProtocol.getSender(event);
        const amount = TokenTransferProtocol.getAmount(event);
        const replyToEventId = TokenTransferProtocol.getReplyToEventId(event);

        console.log(`Sender (from tags): ${sender}`);
        console.log(`Amount: ${amount}`);
        console.log(`ReplyToEventId: ${replyToEventId}`);
        console.log("");

        // Check matching
        console.log("=== MATCHING CHECK ===");
        console.log(`Expected payment request event ID: ${paymentRequestEventId}`);
        console.log(`Received replyToEventId: ${replyToEventId}`);
        console.log(`Match by replyToEventId: ${replyToEventId === paymentRequestEventId}`);
        console.log(`Expected sender pubkey: ${targetPubkey}`);
        console.log(`Received sender: ${sender}`);
        console.log(`Match by sender: ${sender === targetPubkey}`);
        console.log(`Expected amount: ${config.amount}`);
        console.log(`Received amount: ${amount}`);
        console.log(`Amount sufficient: ${amount !== undefined && amount >= config.amount}`);
      }

      console.log("=====================================");
    },
  });

  console.log("Subscribed to token transfers!");
  console.log("");

  // Send payment request
  console.log("Sending payment request...");
  const eventId = await client.sendPaymentRequest(targetPubkey, {
    amount: config.amount,
    coinId: config.coinId,
    recipientNametag: config.nametag,
    message: `Test payment for @${TARGET_UNICITY_ID}`,
  });

  paymentRequestEventId = eventId;
  console.log(`Payment request sent!`);
  console.log(`Event ID: ${eventId}`);
  console.log("");
  console.log(`Waiting for payment from @${TARGET_UNICITY_ID}...`);
  console.log(`(Timeout: ${config.paymentTimeoutSeconds}s)`);
  console.log("");
  console.log("Please approve the payment request in your wallet.");
  console.log("");

  // Wait for timeout
  await new Promise((resolve) => setTimeout(resolve, config.paymentTimeoutSeconds * 1000));

  console.log("");
  console.log("Timeout reached. Disconnecting...");
  client.disconnect();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
