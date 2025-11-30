import { randomBytes } from "crypto";

export interface Config {
  // Nostr relay
  relayUrl: string;

  // Aggregator settings
  aggregatorUrl: string;
  aggregatorApiKey: string;

  // MCP server identity
  privateKeyHex: string;
  nonce: string;
  nametag: string;

  // Payment settings
  coinId: string;
  amount: bigint;

  // Day pass duration in hours
  dayPassDurationHours: number;

  // Payment confirmation timeout in seconds
  paymentTimeoutSeconds: number;

  // Data directory for persistence
  dataDir: string;
}

export function loadConfig(): Config {
  // Check for existing private key or generate new one
  let privateKeyHex = process.env.MCP_PRIVATE_KEY_HEX;
  let nonce = process.env.MCP_NONCE_HEX;

  if (!privateKeyHex) {
    // Generate new keypair
    privateKeyHex = randomBytes(32).toString("hex");
    nonce = randomBytes(32).toString("hex");
    console.error("=".repeat(60));
    console.error("IMPORTANT: No private key found. Generated new identity:");
    console.error(`MCP_PRIVATE_KEY_HEX=${privateKeyHex}`);
    console.error(`MCP_NONCE_HEX=${nonce}`);
    console.error("Save these values to your environment for persistence!");
    console.error("=".repeat(60));
  }

  if (!nonce) {
    nonce = randomBytes(32).toString("hex");
    console.error(`Generated new nonce: MCP_NONCE_HEX=${nonce}`);
  }

  const nametag = process.env.MCP_NAMETAG;
  if (!nametag) {
    throw new Error("MCP_NAMETAG environment variable is required (e.g., 'gaming-mcp')");
  }

  const coinId = process.env.PAYMENT_COIN_ID;
  if (!coinId) {
    throw new Error("PAYMENT_COIN_ID environment variable is required");
  }

  const cleanNametag = nametag.replace("@unicity", "").replace("@", "").trim();

  return {
    relayUrl: process.env.NOSTR_RELAY_URL || "wss://nostr-relay.testnet.unicity.network",
    aggregatorUrl: process.env.AGGREGATOR_URL || "https://aggregator-test.unicity.network",
    aggregatorApiKey: process.env.AGGREGATOR_API_KEY || "sk_06365a9c44654841a366068bcfc68986",
    privateKeyHex,
    nonce,
    nametag: cleanNametag,
    coinId,
    amount: BigInt(process.env.PAYMENT_AMOUNT || "1000000000"),
    dayPassDurationHours: parseInt(process.env.DAY_PASS_HOURS || "24", 10),
    paymentTimeoutSeconds: parseInt(process.env.PAYMENT_TIMEOUT_SECONDS || "120", 10),
    dataDir: process.env.DATA_DIR || "./data",
  };
}
