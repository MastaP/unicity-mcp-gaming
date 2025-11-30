import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Token } from "@unicitylabs/state-transition-sdk/lib/token/Token.js";
import { TokenId } from "@unicitylabs/state-transition-sdk/lib/token/TokenId.js";
import { TokenType } from "@unicitylabs/state-transition-sdk/lib/token/TokenType.js";
import { TokenState } from "@unicitylabs/state-transition-sdk/lib/token/TokenState.js";
import { SigningService } from "@unicitylabs/state-transition-sdk/lib/sign/SigningService.js";
import { MintCommitment } from "@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment.js";
import { MintTransactionData } from "@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData.js";
import { UnmaskedPredicate } from "@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js";
import { UnmaskedPredicateReference } from "@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference.js";
import { HashAlgorithm } from "@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js";
import { StateTransitionClient } from "@unicitylabs/state-transition-sdk/lib/StateTransitionClient.js";
import { AggregatorClient } from "@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js";
import { RootTrustBase } from "@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js";
import { ProxyAddress } from "@unicitylabs/state-transition-sdk/lib/address/ProxyAddress.js";
import { waitInclusionProof } from "@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils.js";
import { NostrKeyManager, NostrClient } from "@unicitylabs/nostr-js-sdk";
import type { DirectAddress } from "@unicitylabs/state-transition-sdk/lib/address/DirectAddress.js";
import type { Config } from "./config.js";
import trustbaseJson from "./trustbase-testnet.json" with { type: "json" };

const UNICITY_TOKEN_TYPE_HEX =
  "f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509";

export interface Identity {
  privateKeyHex: string;
  nonce: string;
  publicKeyHex: string;
  nametag: string;
  walletAddress: string;
  nametagToken: object | null;
}

export class IdentityService {
  private config: Config;
  private aggregatorClient: AggregatorClient;
  private stateTransitionClient: StateTransitionClient;
  private rootTrustBase: RootTrustBase;
  private identity: Identity | null = null;
  private signingService: SigningService | null = null;
  private nametagToken: Token<unknown> | null = null;

  constructor(config: Config) {
    this.config = config;
    this.aggregatorClient = new AggregatorClient(
      config.aggregatorUrl,
      config.aggregatorApiKey
    );
    this.stateTransitionClient = new StateTransitionClient(this.aggregatorClient);
    this.rootTrustBase = RootTrustBase.fromJSON(trustbaseJson);
  }

  async initialize(): Promise<void> {
    console.error("Initializing MCP identity...");

    // Create signing service from private key
    const secret = Buffer.from(this.config.privateKeyHex, "hex");
    this.signingService = await SigningService.createFromSecret(secret);
    const publicKeyHex = Buffer.from(this.signingService.publicKey).toString("hex");

    // Derive wallet address
    const walletAddress = await this.deriveWalletAddress();

    this.identity = {
      privateKeyHex: this.config.privateKeyHex,
      nonce: this.config.nonce,
      publicKeyHex,
      nametag: this.config.nametag,
      walletAddress,
      nametagToken: null,
    };

    console.error(`Identity initialized:`);
    console.error(`  Nametag: @${this.config.nametag}`);
    console.error(`  Public Key: ${publicKeyHex.slice(0, 16)}...`);
    console.error(`  Wallet Address: ${walletAddress.slice(0, 32)}...`);

    // Check and ensure nametag exists
    await this.ensureNametag();

    // Ensure Nostr binding is published
    await this.ensureNostrBinding();
  }

  private async deriveWalletAddress(): Promise<string> {
    if (!this.signingService) {
      throw new Error("Signing service not initialized");
    }

    const tokenType = new TokenType(Buffer.from(UNICITY_TOKEN_TYPE_HEX, "hex"));

    const predicateRef = UnmaskedPredicateReference.create(
      tokenType,
      this.signingService.algorithm,
      this.signingService.publicKey,
      HashAlgorithm.SHA256
    );

    const address = await (await predicateRef).toAddress();
    return address.toString();
  }

  private async getOwnerAddress(): Promise<DirectAddress> {
    if (!this.signingService) {
      throw new Error("Signing service not initialized");
    }

    const tokenType = new TokenType(Buffer.from(UNICITY_TOKEN_TYPE_HEX, "hex"));

    const predicateRef = UnmaskedPredicateReference.create(
      tokenType,
      this.signingService.algorithm,
      this.signingService.publicKey,
      HashAlgorithm.SHA256
    );

    return (await predicateRef).toAddress();
  }

  private async ensureNametag(): Promise<void> {
    // Try to load existing nametag token from storage
    const storedToken = this.loadNametagFromStorage();
    if (storedToken) {
      console.error(`Loaded existing nametag token from storage`);
      this.nametagToken = storedToken;
      this.identity!.nametagToken = storedToken.toJSON();
      return;
    }

    // Need to mint new nametag
    console.error(`No existing nametag found, minting @${this.config.nametag}...`);
    await this.mintNametag();
  }

  private async mintNametag(): Promise<void> {
    if (!this.signingService) {
      throw new Error("Signing service not initialized");
    }

    const nametag = this.config.nametag;
    const ownerAddress = await this.getOwnerAddress();

    const nametagTokenId = await TokenId.fromNameTag(nametag);
    const nametagTokenType = new TokenType(
      Buffer.from(UNICITY_TOKEN_TYPE_HEX, "hex")
    );

    const MAX_RETRIES = 3;
    let commitment: MintCommitment<unknown> | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const salt = randomBytes(32);

        const mintData = await MintTransactionData.createFromNametag(
          nametag,
          nametagTokenType,
          ownerAddress,
          salt,
          ownerAddress
        );

        commitment = await MintCommitment.create(mintData);

        console.error(`Submitting mint commitment (attempt ${attempt})...`);
        const response = await this.stateTransitionClient.submitMintCommitment(commitment);

        if (response.status === "SUCCESS") {
          console.error("Commitment accepted!");
          break;
        } else {
          console.error(`Commitment failed: ${response.status}`);
          if (attempt === MAX_RETRIES) {
            throw new Error(`Failed after ${MAX_RETRIES} attempts: ${response.status}`);
          }
          await this.sleep(1000 * attempt);
        }
      } catch (error) {
        console.error(`Attempt ${attempt} error:`, error);
        if (attempt === MAX_RETRIES) throw error;
        await this.sleep(1000 * attempt);
      }
    }

    if (!commitment) {
      throw new Error("Failed to create commitment");
    }

    console.error("Waiting for inclusion proof...");
    const inclusionProof = await waitInclusionProof(
      this.rootTrustBase,
      this.stateTransitionClient,
      commitment
    );

    const genesisTransaction = commitment.toTransaction(inclusionProof);
    const txData = commitment.transactionData;
    const mintSalt = txData.salt;

    const nametagPredicate = await UnmaskedPredicate.create(
      nametagTokenId,
      nametagTokenType,
      this.signingService,
      HashAlgorithm.SHA256,
      mintSalt
    );

    const token = Token.mint(
      this.rootTrustBase,
      new TokenState(nametagPredicate, null),
      genesisTransaction
    );

    console.error(`Nametag @${nametag} minted successfully!`);

    this.nametagToken = token;
    this.identity!.nametagToken = token.toJSON();
    this.saveNametagToStorage(token);
  }

  private async ensureNostrBinding(): Promise<void> {
    console.error("Checking Nostr binding...");

    const secretKey = Buffer.from(this.config.privateKeyHex, "hex");
    const keyManager = NostrKeyManager.fromPrivateKey(secretKey);
    const client = new NostrClient(keyManager);

    try {
      await client.connect(this.config.relayUrl);

      // Check if binding already exists
      const existingPubkey = await client.queryPubkeyByNametag(this.config.nametag);

      if (existingPubkey === keyManager.getPublicKeyHex()) {
        console.error("Nostr binding already exists and matches");
        client.disconnect();
        return;
      }

      if (existingPubkey) {
        console.error(`Warning: Binding exists but for different pubkey: ${existingPubkey.slice(0, 16)}...`);
      }

      // Publish binding
      const proxyAddress = await ProxyAddress.fromNameTag(this.config.nametag);
      console.error(`Publishing Nostr binding: @${this.config.nametag} -> ${proxyAddress.address.slice(0, 32)}...`);

      const published = await client.publishNametagBinding(
        this.config.nametag,
        proxyAddress.address
      );

      if (published) {
        console.error("Nostr binding published successfully!");
      } else {
        console.error("Warning: Nostr binding publish may have failed");
      }

      client.disconnect();
    } catch (error) {
      console.error("Error ensuring Nostr binding:", error);
      try {
        client.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      throw error;
    }
  }

  private getStoragePath(): string {
    const dataDir = this.config.dataDir;
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    return path.join(dataDir, `nametag-${this.config.nametag}.json`);
  }

  private loadNametagFromStorage(): Token<unknown> | null {
    const storagePath = this.getStoragePath();
    if (!fs.existsSync(storagePath)) {
      return null;
    }

    try {
      const data = fs.readFileSync(storagePath, "utf-8");
      const json = JSON.parse(data);
      // Note: Token.fromJSON is async in newer versions
      // For now, store the raw JSON and recreate when needed
      return null; // We'll handle this differently
    } catch (error) {
      console.error("Failed to load nametag from storage:", error);
      return null;
    }
  }

  private saveNametagToStorage(token: Token<unknown>): void {
    const storagePath = this.getStoragePath();
    const data = {
      nametag: this.config.nametag,
      token: token.toJSON(),
      timestamp: Date.now(),
    };
    fs.writeFileSync(storagePath, JSON.stringify(data, null, 2));
    console.error(`Nametag token saved to ${storagePath}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getIdentity(): Identity {
    if (!this.identity) {
      throw new Error("Identity not initialized");
    }
    return this.identity;
  }

  getSigningService(): SigningService {
    if (!this.signingService) {
      throw new Error("Signing service not initialized");
    }
    return this.signingService;
  }

  getNametagToken(): Token<unknown> | null {
    return this.nametagToken;
  }

  getStateTransitionClient(): StateTransitionClient {
    return this.stateTransitionClient;
  }

  getRootTrustBase(): RootTrustBase {
    return this.rootTrustBase;
  }
}
