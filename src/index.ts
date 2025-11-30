import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, type Config } from "./config.js";
import { IdentityService } from "./identity-service.js";
import { NostrService } from "./nostr-service.js";
import { PaymentTracker } from "./payment-tracker.js";
import type { Game, SessionState } from "./types.js";

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

// Session state (per MCP connection)
const session: SessionState = {
  unicityId: null,
  pubkeyHex: null,
};

let config: Config;
let identityService: IdentityService;
let nostrService: NostrService;
let paymentTracker: PaymentTracker;

const server = new McpServer({
  name: "sphere-gaming",
  version: "1.0.0",
});

// Tool: Set Unicity ID
server.tool(
  "set_unicity_id",
  "Set your Unicity ID (nametag) to access games. This is required before requesting game access.",
  {
    unicity_id: z
      .string()
      .describe("Your Unicity ID (nametag minted on Unicity blockchain)"),
  },
  async ({ unicity_id }) => {
    // Resolve nametag to pubkey
    const pubkey = await nostrService.resolvePubkey(unicity_id);

    if (!pubkey) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Could not find Unicity ID "${unicity_id}". Please make sure you have minted your nametag and published your Nostr binding.`,
          },
        ],
        isError: true,
      };
    }

    session.unicityId = unicity_id.replace("@unicity", "").replace("@", "").trim();
    session.pubkeyHex = pubkey;

    // Check if user already has a valid pass
    const hasPass = paymentTracker.hasValidPass(session.unicityId);
    const passStatus = hasPass
      ? `You have an active day pass (${paymentTracker.formatRemainingTime(session.unicityId)}).`
      : "You don't have an active day pass. Use get_game to request access.";

    return {
      content: [
        {
          type: "text" as const,
          text: `Unicity ID set to "@${session.unicityId}". ${passStatus}`,
        },
      ],
    };
  }
);

// Tool: Check access status
server.tool(
  "check_access",
  "Check your current access status and day pass validity",
  {},
  async () => {
    if (!session.unicityId) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No Unicity ID set. Please use set_unicity_id first.",
          },
        ],
        isError: true,
      };
    }

    const hasPass = paymentTracker.hasValidPass(session.unicityId);

    if (hasPass) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                unicityId: `@${session.unicityId}`,
                hasAccess: true,
                remainingTime: paymentTracker.formatRemainingTime(session.unicityId),
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
              unicityId: `@${session.unicityId}`,
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

    const accessNote = session.unicityId
      ? paymentTracker.hasValidPass(session.unicityId)
        ? "You have an active day pass."
        : "You need a day pass to access games."
      : "Set your Unicity ID first to access games.";

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              games: gameList,
              accessNote,
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
    game: z
      .string()
      .describe("Game identifier (unicity-quake, boxy-run, or unirun)"),
  },
  async ({ game }) => {
    // Check if Unicity ID is set
    if (!session.unicityId || !session.pubkeyHex) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Please set your Unicity ID first using set_unicity_id.",
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
    if (paymentTracker.hasValidPass(session.unicityId)) {
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
                passRemaining: paymentTracker.formatRemainingTime(session.unicityId),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // No valid pass - initiate payment
    const { requestId } = await nostrService.sendPaymentRequest(
      session.unicityId,
      session.pubkeyHex
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "payment_required",
              message: `Payment request sent to your wallet (@${session.unicityId}). Please approve the payment to get a day pass.`,
              requestId,
              timeoutSeconds: config.paymentTimeoutSeconds,
              nextStep: "Use confirm_payment tool to wait for payment confirmation.",
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
  "Wait for payment confirmation after a payment request has been sent",
  {},
  async () => {
    if (!session.unicityId || !session.pubkeyHex) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No active session. Please set your Unicity ID first.",
          },
        ],
        isError: true,
      };
    }

    // Check if already has pass
    if (paymentTracker.hasValidPass(session.unicityId)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "already_active",
                message: "You already have an active day pass.",
                remainingTime: paymentTracker.formatRemainingTime(session.unicityId),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Send new payment request and wait
    const { waitForPayment } = await nostrService.sendPaymentRequest(
      session.unicityId,
      session.pubkeyHex
    );

    const paymentReceived = await waitForPayment();

    if (paymentReceived) {
      const pass = paymentTracker.grantDayPass(session.unicityId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "payment_confirmed",
                message: "Payment received! Day pass granted.",
                validUntil: new Date(pass.expiresAt).toISOString(),
                remainingTime: paymentTracker.formatRemainingTime(session.unicityId),
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

  // Initialize Nostr service
  console.error("Connecting to Nostr...");
  nostrService = new NostrService(config, identityService);
  await nostrService.connect();

  // Start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("=".repeat(60));
  console.error("Sphere Gaming MCP Server is ready!");
  console.error(`  Nametag: @${config.nametag}`);
  console.error(`  Relay: ${config.relayUrl}`);
  console.error(`  Payment amount: ${config.amount}`);
  console.error(`  Day pass duration: ${config.dayPassDurationHours}h`);
  console.error("=".repeat(60));
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
