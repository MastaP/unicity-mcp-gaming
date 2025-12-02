import "dotenv/config";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { z } from "zod";
import { loadConfig, type Config } from "./config.js";
import { IdentityService } from "./identity-service.js";
import { NostrService } from "./nostr-service.js";
import { PaymentTracker } from "./payment-tracker.js";
import { WalletService } from "./wallet-service.js";
import type { Game } from "./types.js";

const GAMES: Record<string, Game> = {
  "unicity-quake": {
    name: "Unicity Quake",
    url: "https://quake.unicity.network",
    description: "Fast-paced multiplayer arena shooter",
  },
  "boxy-run": {
    name: "Boxy Run",
    url: "https://unicitynetwork.github.io/Boxy-Run/",
    description: "Endless runner with blockchain rewards",
  },
  unirun: {
    name: "Unirun",
    url: "https://unirun.unicity.network",
    description: "Unicity-native endless runner",
  },
};

// Cache for resolved pubkeys (unicity_id -> pubkey)
const pubkeyCache: Map<string, { pubkey: string; timestamp: number }> = new Map();
const PUBKEY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let config: Config;
let identityService: IdentityService;
let nostrService: NostrService;
let paymentTracker: PaymentTracker;
let walletService: WalletService;

// Helper: Resolve and cache pubkey for a unicity_id
async function resolvePubkey(unicityId: string): Promise<string | null> {
  const cleanId = unicityId.replace("@unicity", "").replace("@", "").trim();

  // Check cache
  const cached = pubkeyCache.get(cleanId);
  if (cached && Date.now() - cached.timestamp < PUBKEY_CACHE_TTL_MS) {
    return cached.pubkey;
  }

  // Resolve from Nostr
  const pubkey = await nostrService.resolvePubkey(cleanId);
  if (pubkey) {
    pubkeyCache.set(cleanId, { pubkey, timestamp: Date.now() });
  }

  return pubkey;
}

// Helper: Clean unicity_id
function cleanUnicityId(unicityId: string): string {
  return unicityId.replace("@unicity", "").replace("@", "").trim();
}

// Register all tools on an MCP server
function registerTools(server: McpServer): void {
  // Tool: Check access status
  server.tool(
  "check_access",
  "Check access status and day pass validity for a Unicity ID",
  {
    unicity_id: z
      .string()
      .describe("Unicity ID (nametag) to check access for"),
  },
  async ({ unicity_id }) => {
    const unicityId = cleanUnicityId(unicity_id);

    // Verify the unicity_id exists
    const pubkey = await resolvePubkey(unicityId);
    if (!pubkey) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Could not find Unicity ID "${unicity_id}". Make sure the nametag is minted and has a Nostr binding.`,
          },
        ],
        isError: true,
      };
    }

    const hasPass = paymentTracker.hasValidPass(unicityId);

    if (hasPass) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                unicityId: `@${unicityId}`,
                hasAccess: true,
                remainingTime: paymentTracker.formatRemainingTime(unicityId),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              unicityId: `@${unicityId}`,
              hasAccess: false,
              message: "No active day pass. Use get_game to request a game and complete payment.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Tool: List available games
server.tool(
  "list_games",
  "List all available games on the Unicity gaming platform",
  {},
  async () => {
    const gameList = Object.entries(GAMES).map(([id, game]) => ({
      id,
      name: game.name,
      description: game.description,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              games: gameList,
              note: "Use get_game with your unicity_id to access a game.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Tool: Get game (with payment flow)
server.tool(
  "get_game",
  "Get access to a specific game. Requires a valid day pass or will initiate payment.",
  {
    unicity_id: z
      .string()
      .describe("Your Unicity ID (nametag)"),
    game: z
      .string()
      .describe("Game identifier (unicity-quake, boxy-run, or unirun)"),
  },
  async ({ unicity_id, game }) => {
    const unicityId = cleanUnicityId(unicity_id);

    // Resolve pubkey
    const pubkey = await resolvePubkey(unicityId);
    if (!pubkey) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Could not find Unicity ID "${unicity_id}". Make sure the nametag is minted and has a Nostr binding.`,
          },
        ],
        isError: true,
      };
    }

    // Validate game
    const normalizedId = game.toLowerCase().replace(/\s+/g, "-");
    const gameData = GAMES[normalizedId];

    if (!gameData) {
      const availableGames = Object.keys(GAMES).join(", ");
      return {
        content: [
          {
            type: "text" as const,
            text: `Game "${game}" not found. Available games: ${availableGames}`,
          },
        ],
        isError: true,
      };
    }

    // Check if user has valid day pass
    if (paymentTracker.hasValidPass(unicityId)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "access_granted",
                game: {
                  id: normalizedId,
                  name: gameData.name,
                  url: gameData.url,
                  description: gameData.description,
                },
                passRemaining: paymentTracker.formatRemainingTime(unicityId),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // No valid pass - initiate payment
    const { eventId } = await nostrService.sendPaymentRequest(
      unicityId,
      pubkey
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "payment_required",
              message: `Payment request sent to your wallet (@${unicityId}). Please approve the payment to get a day pass.`,
              paymentRequestEventId: eventId,
              timeoutSeconds: config.paymentTimeoutSeconds,
              nextStep: `Use confirm_payment with unicity_id "${unicityId}" to wait for payment confirmation.`,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Tool: Wait for payment confirmation
server.tool(
  "confirm_payment",
  "Wait for payment confirmation after a payment request has been sent. Optionally specify a game to get direct access after payment.",
  {
    unicity_id: z
      .string()
      .describe("Your Unicity ID (nametag) that the payment request was sent to"),
    game: z
      .string()
      .optional()
      .describe("Optional: Game to access after payment (unicity-quake, boxy-run, or unirun)"),
  },
  async ({ unicity_id, game }) => {
    const unicityId = cleanUnicityId(unicity_id);

    // Resolve pubkey
    const pubkey = await resolvePubkey(unicityId);
    if (!pubkey) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Could not find Unicity ID "${unicity_id}". Make sure the nametag is minted and has a Nostr binding.`,
          },
        ],
        isError: true,
      };
    }

    // Validate game if provided
    let gameData: Game | undefined;
    let normalizedGameId: string | undefined;
    if (game) {
      normalizedGameId = game.toLowerCase().replace(/\s+/g, "-");
      gameData = GAMES[normalizedGameId];
      if (!gameData) {
        const availableGames = Object.keys(GAMES).join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text: `Game "${game}" not found. Available games: ${availableGames}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Check if already has pass
    if (paymentTracker.hasValidPass(unicityId)) {
      const result: Record<string, unknown> = {
        status: "already_active",
        message: "You already have an active day pass.",
        remainingTime: paymentTracker.formatRemainingTime(unicityId),
      };

      if (gameData && normalizedGameId) {
        result.game = {
          id: normalizedGameId,
          name: gameData.name,
          url: gameData.url,
          description: gameData.description,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    // Check if there's already a pending payment for this user
    const existingEventId = nostrService.getPendingPaymentForUser(unicityId);
    let paymentReceived: boolean;

    if (existingEventId) {
      // Wait for existing pending payment
      console.error(`Waiting for existing pending payment ${existingEventId.slice(0, 16)}... for user ${unicityId}`);
      const existingPromise = nostrService.waitForExistingPayment(existingEventId);
      if (existingPromise) {
        paymentReceived = await existingPromise;
      } else {
        // Pending payment was resolved between check and wait, re-check pass status
        paymentReceived = paymentTracker.hasValidPass(unicityId);
      }
    } else {
      // No existing pending payment - re-check pass status in case payment arrived
      if (paymentTracker.hasValidPass(unicityId)) {
        paymentReceived = true;
      } else {
        // Send a new request
        const { waitForPayment } = await nostrService.sendPaymentRequest(
          unicityId,
          pubkey
        );
        paymentReceived = await waitForPayment();
      }
    }

    if (paymentReceived) {
      const pass = paymentTracker.grantDayPass(unicityId);

      const result: Record<string, unknown> = {
        status: "payment_confirmed",
        message: "Payment received! Day pass granted.",
        validUntil: new Date(pass.expiresAt).toISOString(),
        remainingTime: paymentTracker.formatRemainingTime(unicityId),
      };

      if (gameData && normalizedGameId) {
        result.game = {
          id: normalizedGameId,
          name: gameData.name,
          url: gameData.url,
          description: gameData.description,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "payment_timeout",
              message: "Payment not received within timeout. Please try again or check your wallet.",
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
);

// Tool: Get wallet balance (requires password)
server.tool(
  "get_wallet_balance",
  "Get the total token balance in the MCP wallet (requires admin password)",
  {
    password: z
      .string()
      .describe("Admin password for authentication"),
  },
  async ({ password }) => {
    // Verify password
    if (password !== config.adminPassword) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Invalid admin password.",
          },
        ],
        isError: true,
      };
    }

    try {
      const summary = await walletService.getWalletSummary();

      // Format balances for display
      const balanceInfo = summary.balances.map((b) => ({
        coinId: b.coinId,
        amount: b.amount.toString(),
        tokenCount: b.tokenCount,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                totalTokenFiles: summary.totalTokens,
                balances: balanceInfo,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error reading wallet: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  });
}

async function main() {
  console.error("Starting Sphere Gaming MCP Server...");

  // Load configuration
  config = loadConfig();

  // Initialize identity service (creates/loads nametag)
  console.error("Initializing identity...");
  identityService = new IdentityService(config);
  await identityService.initialize();

  // Initialize payment tracker
  paymentTracker = new PaymentTracker(config.dayPassDurationHours);

  // Initialize wallet service
  walletService = new WalletService(config);

  // Initialize Nostr service
  console.error("Connecting to Nostr...");
  nostrService = new NostrService(config, identityService);

  // Set up callback to grant day pass when payment is received
  nostrService.setPaymentConfirmedCallback((unicityId) => {
    console.error(`Granting day pass to ${unicityId} via payment callback`);
    paymentTracker.grantDayPass(unicityId);
  });

  await nostrService.connect();

  // Start HTTP server
  await startHttpServer(config.httpPort);

  console.error("=".repeat(60));
  console.error("Sphere Gaming MCP Server is ready!");
  console.error(`  Nametag: @${config.nametag}`);
  console.error(`  Relay: ${config.relayUrl}`);
  console.error(`  Payment amount: ${config.amount}`);
  console.error(`  Day pass duration: ${config.dayPassDurationHours}h`);
  console.error(`  HTTP port: ${config.httpPort}`);
  console.error("=".repeat(60));
}

// Legacy SSE transports (for MCP Inspector and older clients)
const sseTransports = new Map<string, SSEServerTransport>();

// Streamable HTTP transports (modern MCP clients)
const httpTransports = new Map<string, StreamableHTTPServerTransport>();

async function startHttpServer(port: number): Promise<void> {
  const app = express();

  // CORS middleware
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.json());

  // ===========================================
  // Legacy SSE Transport (for MCP Inspector)
  // ===========================================

  // GET /sse - establish SSE stream
  app.get("/sse", async (req: Request, res: Response) => {
    const transport = new SSEServerTransport("/messages", res);
    sseTransports.set(transport.sessionId, transport);

    const server = new McpServer({
      name: "sphere-gaming",
      version: "1.0.0",
    });
    registerTools(server);

    res.on("close", () => {
      sseTransports.delete(transport.sessionId);
      console.error(`SSE session closed: ${transport.sessionId}`);
    });

    await server.connect(transport);
    console.error(`SSE session created: ${transport.sessionId}`);
  });

  // POST /messages - receive messages for SSE transport
  app.post("/messages", async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    const transport = sseTransports.get(sessionId);

    if (!transport) {
      res.status(404).json({ error: "SSE session not found" });
      return;
    }

    await transport.handlePostMessage(req, res, req.body);
  });

  // ===========================================
  // Streamable HTTP Transport (modern clients)
  // ===========================================

  app.all("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !httpTransports.has(sessionId)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          httpTransports.set(newSessionId, transport);
          console.error(`HTTP session created: ${newSessionId}`);
        },
        onsessionclosed: (closedSessionId) => {
          httpTransports.delete(closedSessionId);
          console.error(`HTTP session closed: ${closedSessionId}`);
        },
      });

      const server = new McpServer({
        name: "sphere-gaming",
        version: "1.0.0",
      });
      registerTools(server);

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    const transport = httpTransports.get(sessionId);
    if (transport) {
      await transport.handleRequest(req, res, req.body);
    } else {
      res.status(404).json({ error: "Session not found" });
    }
  });

  // ===========================================
  // Health check
  // ===========================================

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      sseSessions: sseTransports.size,
      httpSessions: httpTransports.size,
    });
  });

  app.listen(port, () => {
    console.error(`HTTP server listening on port ${port}`);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
