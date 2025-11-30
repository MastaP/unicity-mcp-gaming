FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/build ./build

# Create data directory for nametag storage
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

# Required environment variables (must be set at runtime):
# MCP_NAMETAG - The nametag for this MCP server (e.g., "gaming-mcp")
# PAYMENT_COIN_ID - The coin ID for payments
#
# Optional environment variables:
# MCP_PRIVATE_KEY_HEX - Private key (generated if not provided)
# NOSTR_RELAY_URL - Nostr relay URL
# AGGREGATOR_URL - Unicity aggregator URL
# AGGREGATOR_API_KEY - Aggregator API key
# PAYMENT_AMOUNT - Payment amount in smallest units
# DAY_PASS_HOURS - Day pass duration in hours
# PAYMENT_TIMEOUT_SECONDS - Payment confirmation timeout

CMD ["node", "build/index.js"]
