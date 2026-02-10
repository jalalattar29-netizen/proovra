/**
 * API Keys Service
 * Manages API key generation, validation, and rate limiting for third-party integrations
 */

import crypto from "crypto";
import { prisma } from "../db.js";

export interface APIKeyMetadata {
  id: string;
  userId: string;
  keyHash: string; // Never store raw key
  name: string;
  createdAt: Date;
  lastUsedAt?: Date;
  expiresAt?: Date;
  rateLimit: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
  isActive: boolean;
  scopes: string[]; // e.g., ["analyze:read", "insights:read"]
}

interface RateLimitUsage {
  minuteRequests: number;
  dayRequests: number;
  resetMinuteAt: Date;
  resetDayAt: Date;
}

class APIKeyService {
  private rateLimitStore = new Map<string, RateLimitUsage>();

  /**
   * Generate a new API key
   */
  generateKey(): { raw: string; hash: string } {
    const raw = `pw_${crypto.randomBytes(32).toString("hex")}`;
    const hash = this.hashKey(raw);
    return { raw, hash };
  }

  /**
   * Hash API key for storage
   */
  private hashKey(key: string): string {
    return crypto.createHash("sha256").update(key).digest("hex");
  }

  /**
   * Create a new API key
   */
  async createKey(
    userId: string,
    name: string,
    scopes: string[] = ["analyze:read"],
    expiresInDays?: number
  ): Promise<{ raw: string; metadata: APIKeyMetadata }> {
    const { raw, hash } = this.generateKey();

    // Calculate expiration
    let expiresAt: Date | undefined;
    if (expiresInDays) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expiresInDays);
    }

    // Store in memory (production would use database)
    const metadata: APIKeyMetadata = {
      id: `key_${crypto.randomBytes(12).toString("hex")}`,
      userId,
      keyHash: hash,
      name,
      createdAt: new Date(),
      expiresAt,
      rateLimit: {
        requestsPerMinute: 60,
        requestsPerDay: 10000,
      },
      isActive: true,
      scopes,
    };

    // Store key metadata (in production, would save to database)
    // For now, we'll store in memory for demo purposes
    this.keyStore.set(hash, metadata);

    return { raw, metadata };
  }

  /**
   * Validate API key and check rate limits
   */
  async validateKey(
    rawKey: string,
    scope?: string
  ): Promise<{ valid: boolean; userId?: string; error?: string }> {
    const hash = this.hashKey(rawKey);

    // Check if key exists
    const metadata = this.keyStore.get(hash);
    if (!metadata) {
      return { valid: false, error: "Invalid API key" };
    }

    // Check if key is active
    if (!metadata.isActive) {
      return { valid: false, error: "API key is inactive" };
    }

    // Check expiration
    if (metadata.expiresAt && new Date() > metadata.expiresAt) {
      return { valid: false, error: "API key has expired" };
    }

    // Check scope
    if (scope && !metadata.scopes.includes(scope)) {
      return { valid: false, error: `API key does not have ${scope} scope` };
    }

    // Check rate limits
    const rateLimitOk = this.checkRateLimit(hash, metadata);
    if (!rateLimitOk) {
      return { valid: false, error: "Rate limit exceeded" };
    }

    // Update last used time
    metadata.lastUsedAt = new Date();

    return { valid: true, userId: metadata.userId };
  }

  /**
   * Check and track rate limit usage
   */
  private checkRateLimit(hash: string, metadata: APIKeyMetadata): boolean {
    let usage = this.rateLimitStore.get(hash);

    // Initialize or reset if needed
    const now = new Date();
    if (!usage || now > usage.resetMinuteAt) {
      usage = {
        minuteRequests: 0,
        dayRequests: 0,
        resetMinuteAt: new Date(now.getTime() + 60000), // 1 minute
        resetDayAt: new Date(now.getTime() + 86400000), // 1 day
      };
    }

    // Reset day counter if needed
    if (now > usage.resetDayAt) {
      usage.dayRequests = 0;
      usage.resetDayAt = new Date(now.getTime() + 86400000);
    }

    // Check limits
    if (usage.minuteRequests >= metadata.rateLimit.requestsPerMinute) {
      return false;
    }
    if (usage.dayRequests >= metadata.rateLimit.requestsPerDay) {
      return false;
    }

    // Increment counters
    usage.minuteRequests++;
    usage.dayRequests++;
    this.rateLimitStore.set(hash, usage);

    return true;
  }

  /**
   * List all keys for a user
   */
  listKeys(userId: string): APIKeyMetadata[] {
    const keys: APIKeyMetadata[] = [];
    this.keyStore.forEach((metadata) => {
      if (metadata.userId === userId) {
        keys.push(metadata);
      }
    });
    return keys;
  }

  /**
   * Revoke an API key
   */
  revokeKey(userId: string, keyId: string): boolean {
    let found = false;
    this.keyStore.forEach((metadata) => {
      if (metadata.userId === userId && metadata.id === keyId) {
        metadata.isActive = false;
        found = true;
      }
    });
    return found;
  }

  /**
   * Rotate API key (revoke old, create new)
   */
  async rotateKey(
    userId: string,
    keyId: string,
    name: string
  ): Promise<{ raw: string; metadata: APIKeyMetadata } | null> {
    // Find old key
    let oldMetadata: APIKeyMetadata | undefined;
    this.keyStore.forEach((metadata) => {
      if (metadata.userId === userId && metadata.id === keyId) {
        oldMetadata = metadata;
      }
    });

    if (!oldMetadata) return null;

    // Revoke old key
    this.revokeKey(userId, keyId);

    // Create new key with same scopes
    return this.createKey(userId, name, oldMetadata.scopes);
  }

  /**
   * Get key usage stats
   */
  getKeyStats(keyId: string): { usage: RateLimitUsage | undefined } {
    // In production, would query from database
    // For now, return from rate limit store
    const usage = this.rateLimitStore.get(keyId);
    return { usage };
  }

  /**
   * Update rate limits
   */
  updateRateLimit(
    userId: string,
    keyId: string,
    requestsPerMinute: number,
    requestsPerDay: number
  ): boolean {
    let found = false;
    this.keyStore.forEach((metadata) => {
      if (metadata.userId === userId && metadata.id === keyId) {
        metadata.rateLimit.requestsPerMinute = requestsPerMinute;
        metadata.rateLimit.requestsPerDay = requestsPerDay;
        found = true;
      }
    });
    return found;
  }

  // In-memory store for demo (production would use database)
  private keyStore = new Map<string, APIKeyMetadata>();
}

export const apiKeyService = new APIKeyService();
