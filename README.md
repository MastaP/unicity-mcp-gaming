# Sphere MCP Gaming Server

MCP (Model Context Protocol) server for the Unicity gaming platform. Provides LLM access to games with payment-gated day passes via Nostr.

## Features

- **Day Pass System**: Users pay once for 24-hour access to all games
- **Nostr Integration**: Payment requests sent via Nostr protocol
- **Unicity Blockchain**: Uses nametags for identity and payment routing
- **Auto Identity**: Server creates its own blockchain identity on first run
- **HTTP Transport**: Supports both legacy SSE and modern Streamable HTTP

## Available Games

| ID | Name | Description |
|----|------|-------------|
| `unicity-quake` | Unicity Quake | Fast-paced multiplayer arena shooter |
| `boxy-run` | Boxy Run | Endless runner with blockchain rewards |
| `unirun` | Unirun | Unicity-native endless runner |

## MCP Tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `list_games` | - | List all available games |
| `check_access` | `unicity_id` | Check access status and day pass validity |
| `get_game` | `unicity_id`, `game` | Get access to a specific game (initiates payment if needed) |
| `confirm_payment` | `unicity_id`, `game` (optional) | Wait for payment confirmation |
| `get_wallet_balance` | `password` | Get MCP wallet balance (admin) |

All tools that require user identity take `unicity_id` as a parameter, making the API stateless and suitable for multi-user scenarios.

## HTTP Endpoints

The server runs on HTTP (default port 3001) with two transport protocols:

### Legacy SSE (MCP Inspector, older clients)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sse` | GET | Establish SSE stream, returns POST endpoint |
| `/messages?sessionId=xxx` | POST | Send JSON-RPC messages |

### Streamable HTTP (modern clients)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | Send JSON-RPC requests |
| `/mcp` | GET | SSE stream for responses |

Session ID is passed via `mcp-session-id` header.

### Health Check

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Returns `{ status, sseSessions, httpSessions }` |

## Quick Start

### 1. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with required values:
```env
# Required
MCP_NAMETAG=gaming-mcp
PAYMENT_COIN_ID=your_coin_id_here
```

### 2. Run with Docker Compose

```bash
docker compose up -d
```

The server will:
1. Generate a new private key (saved to `./data/identity.json`)
2. Mint a nametag on Unicity blockchain
3. Publish Nostr binding for the nametag
4. Start listening for MCP connections

### 3. View Logs

```bash
docker compose logs -f
```

## Testing the MCP

### Option 1: MCP Inspector (Recommended)

The MCP Inspector provides a web UI to interact with the server:

```bash
# Start the server
npm run build && npm start

# In another terminal, connect inspector to HTTP endpoint
npx @modelcontextprotocol/inspector --url http://localhost:3001/sse
```

This opens a browser UI where you can call tools interactively.

### Option 2: curl (Health Check)

```bash
curl http://localhost:3001/health
```

### Option 3: Claude Desktop Integration

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "gaming": {
      "url": "http://localhost:3001/sse"
    }
  }
}
```

## Example Workflow

1. **User lists available games:**
   ```
   Tool: list_games
   ```

2. **User requests a game with their Unicity ID:**
   ```
   Tool: get_game
   Args: { "unicity_id": "alice", "game": "unicity-quake" }
   ```

3. **If no day pass, payment is requested.** The user receives a payment request in their Unicity wallet.

4. **User confirms payment:**
   ```
   Tool: confirm_payment
   Args: { "unicity_id": "alice" }
   ```

5. **On successful payment, user gets game URL and 24h access.**

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_NAMETAG` | Yes | - | Nametag for this MCP server |
| `PAYMENT_COIN_ID` | Yes | - | Coin ID for payments |
| `MCP_PRIVATE_KEY_HEX` | No | Auto-generated | Private key (hex) |
| `NOSTR_RELAY_URL` | No | `wss://nostr-relay.testnet.unicity.network` | Nostr relay |
| `AGGREGATOR_URL` | No | `https://goggregator-test.unicity.network` | Unicity aggregator |
| `AGGREGATOR_API_KEY` | No | (testnet key) | Aggregator API key |
| `PAYMENT_AMOUNT` | No | `1000000000` | Payment amount |
| `DAY_PASS_HOURS` | No | `24` | Day pass duration |
| `PAYMENT_TIMEOUT_SECONDS` | No | `120` | Payment timeout |
| `DATA_DIR` | No | `./data` | Data persistence directory |
| `ADMIN_PASSWORD` | No | Auto-generated | Admin password for wallet access |
| `HTTP_PORT` | No | `3001` | HTTP server port |

## Data Persistence

The server stores identity and nametag data in `DATA_DIR`:

- `identity.json` - Private key (keep this safe!)
- `nametag-{name}.json` - Minted nametag token

Mount this directory as a volume to persist across container restarts.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run locally
npm start

# Watch mode
npm run dev
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   LLM Client    │────▶│   MCP Server    │────▶│  Nostr Relay    │
│ (Claude, etc.)  │     │ (HTTP transport)│     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │                        │
                               ▼                        ▼
                        ┌─────────────────┐     ┌─────────────────┐
                        │    Unicity      │     │  User Wallet    │
                        │   Aggregator    │     │  (Sphere app)   │
                        └─────────────────┘     └─────────────────┘
```

## License

MIT
