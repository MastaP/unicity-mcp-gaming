export interface Config {
  // Nostr relay
  relayUrl: string;

  // Payment settings
  coinId: string;
  amount: bigint;
  recipientNametag: string;

  // MCP server identity (Nostr private key in hex)
  privateKeyHex: string;

  // Day pass duration in hours
  dayPassDurationHours: number;

  // Payment confirmation timeout in seconds
  paymentTimeoutSeconds: number;
}

export function loadConfig(): Config {
  const privateKeyHex = process.env.MCP_PRIVATE_KEY_HEX;
  if (!privateKeyHex) {
    throw new Error("MCP_PRIVATE_KEY_HEX environment variable is required");
  }

  const coinId = process.env.PAYMENT_COIN_ID;
  if (!coinId) {
    throw new Error("PAYMENT_COIN_ID environment variable is required");
  }

  const recipientNametag = process.env.PAYMENT_RECIPIENT_NAMETAG;
  if (!recipientNametag) {
    throw new Error("PAYMENT_RECIPIENT_NAMETAG environment variable is required");
  }

  return {
    relayUrl: process.env.NOSTR_RELAY_URL || "wss://nostr-relay.testnet.unicity.network",
    coinId,
    amount: BigInt(process.env.PAYMENT_AMOUNT || "1000000000"),
    recipientNametag,
    privateKeyHex,
    dayPassDurationHours: parseInt(process.env.DAY_PASS_HOURS || "24", 10),
    paymentTimeoutSeconds: parseInt(process.env.PAYMENT_TIMEOUT_SECONDS || "120", 10),
  };
}
