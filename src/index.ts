import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

interface Game {
  name: string;
  url: string;
  description: string;
}

const GAMES: Record<string, Game> = {
  "unicity-quake": {
    name: "Unicity Quake",
    url: "https://quake.unicity.network",
    description: "Fast-paced multiplayer arena shooter"
  },
  "boxy-run": {
    name: "Boxy Run",
    url: "https://unicitynetwork.github.io/Boxy-Run/",
    description: "Endless runner with blockchain rewards"
  },
  "unirun": {
    name: "Unirun",
    url: "https://unirun.unicity.network",
    description: "Unicity-native endless runner"
  }
};

const server = new McpServer({
  name: "sphere-gaming",
  version: "1.0.0"
});

server.tool(
  "list_games",
  "List all available games on the Unicity gaming platform",
  {},
  async () => {
    const gameList = Object.entries(GAMES).map(([id, game]) => ({
      id,
      name: game.name,
      description: game.description
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(gameList, null, 2)
        }
      ]
    };
  }
);

server.tool(
  "get_game",
  "Get details and URL for a specific game",
  {
    game: z.string().describe("Game identifier (unicity-quake, boxy-run, or unirun)")
  },
  async ({ game }) => {
    const normalizedId = game.toLowerCase().replace(/\s+/g, "-");
    const gameData = GAMES[normalizedId];

    if (!gameData) {
      const availableGames = Object.keys(GAMES).join(", ");
      return {
        content: [
          {
            type: "text" as const,
            text: `Game "${game}" not found. Available games: ${availableGames}`
          }
        ],
        isError: true
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            id: normalizedId,
            name: gameData.name,
            url: gameData.url,
            description: gameData.description
          }, null, 2)
        }
      ]
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Sphere Gaming MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
