import crypto from 'crypto';
import { AppError, ErrorCode } from '../utils/app-error.js';

// Webhook event types
export enum WebhookEventType {
  ANALYSIS_COMPLETE = 'analysis_complete',
  EVIDENCE_CREATED = 'evidence_created',
  EVIDENCE_VERIFIED = 'evidence_verified',
  MEMBER_JOINED = 'member_joined',
  BATCH_COMPLETE = 'batch_complete',
  BATCH_FAILED = 'batch_failed',
  QUOTA_EXCEEDED = 'quota_exceeded',
}

// Webhook status types
export enum WebhookStatus {
  PENDING = 'pending',
  DELIVERED = 'delivered',
  FAILED = 'failed',
}

// Webhook interface
export interface Webhook {
  id: string;
  organizationId: string;
  url: string;
  events: string[];
  secret: string;
  isActive: boolean;
  failureCount: number;
  lastTriggeredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Webhook event interface
export interface WebhookEvent {
  id: string;
  webhookId: string;
  type: string;
  payload: Record<string, any>;
  status: WebhookStatus;
  attempt: number;
  nextRetryAt?: Date;
  createdAt: Date;
  httpStatus?: number;
  errorMessage?: string;
}

// Service class
export class WebhookService {
  // In-memory storage for MVP
  private webhooks = new Map<string, Webhook>();
  private webhookEvents = new Map<string, WebhookEvent>();
  private eventQueues = new Map<string, WebhookEvent[]>();

  // Configuration
  private maxAttempts = 5;
  private retryDelays = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000]; // 1m, 5m, 15m, 1h

  /**
   * Create a new webhook
   */
  createWebhook(
    organizationId: string,
    url: string,
    events: string[]
  ): Webhook {
    // Validate URL (must be HTTPS in production, HTTP allowed for dev)
    const urlObj = new URL(url);
    if (process.env.NODE_ENV === 'production' && urlObj.protocol !== 'https:') {
      throw new AppError(
        'Webhook URL must be HTTPS',
        ErrorCode.VALIDATION_ERROR,
        400
      );
    }

    // Validate events
    if (!events || events.length === 0) {
      throw new AppError(
        'At least one event type must be specified',
        ErrorCode.VALIDATION_ERROR,
        400
      );
    }

    // Generate webhook ID and secret
    const id = `wh_${crypto.randomBytes(16).toString('hex')}`;
    const secret = crypto.randomBytes(32).toString('hex');

    const webhook: Webhook = {
      id,
      organizationId,
      url,
      events,
      secret,
      isActive: true,
      failureCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.webhooks.set(id, webhook);

    return webhook;
  }

  /**
   * Get webhook by ID
   */
  getWebhook(webhookId: string): Webhook | null {
    return this.webhooks.get(webhookId) || null;
  }

  /**
   * List webhooks for organization
   */
  listWebhooks(organizationId: string): Webhook[] {
    return Array.from(this.webhooks.values()).filter(
      (w) => w.organizationId === organizationId
    );
  }

  /**
   * Update webhook
   */
  updateWebhook(
    webhookId: string,
    updates: Partial<Webhook>
  ): Webhook {
    const webhook = this.webhooks.get(webhookId);
    if (!webhook) {
      throw new AppError('Webhook not found', ErrorCode.NOT_FOUND, 404);
    }

    const updated = {
      ...webhook,
      ...updates,
      id: webhook.id, // Prevent ID changes
      organizationId: webhook.organizationId, // Prevent org changes
      secret: webhook.secret, // Prevent secret changes
      createdAt: webhook.createdAt, // Prevent timestamp changes
      updatedAt: new Date(),
    };

    this.webhooks.set(webhookId, updated);
    return updated;
  }

  /**
   * Delete webhook
   */
  deleteWebhook(webhookId: string): void {
    this.webhooks.delete(webhookId);
    // Also delete associated events
    const eventsToDelete = Array.from(this.webhookEvents.entries())
      .filter(([_, e]) => e.webhookId === webhookId)
      .map(([id]) => id);
    eventsToDelete.forEach((id) => this.webhookEvents.delete(id));
  }

  /**
   * Trigger webhook event
   */
  async triggerEvent(
    organizationId: string,
    eventType: string,
    payload: Record<string, any>
  ): Promise<void> {
    // Get active webhooks for this organization that are subscribed to this event
    const webhooks = this.listWebhooks(organizationId).filter(
      (w) => w.isActive && w.events.includes(eventType)
    );

    for (const webhook of webhooks) {
      await this.queueEvent(webhook.id, eventType, payload);
    }
  }

  /**
   * Queue event for delivery with retry logic
   */
  async queueEvent(
    webhookId: string,
    eventType: string,
    payload: Record<string, any>
  ): Promise<void> {
    const webhook = this.getWebhook(webhookId);
    if (!webhook) {
      throw new AppError('Webhook not found', ErrorCode.NOT_FOUND, 404);
    }

    const eventId = `evt_${crypto.randomBytes(16).toString('hex')}`;
    const event: WebhookEvent = {
      id: eventId,
      webhookId,
      type: eventType,
      payload,
      status: WebhookStatus.PENDING,
      attempt: 1,
      nextRetryAt: new Date(),
      createdAt: new Date(),
    };

    this.webhookEvents.set(eventId, event);

    // Attempt immediate delivery
    await this.deliverEvent(event, webhook);
  }

  /**
   * Deliver webhook event to target URL
   */
  private async deliverEvent(
    event: WebhookEvent,
    webhook: Webhook
  ): Promise<void> {
    try {
      const signature = this.signPayload(event.payload, webhook.secret);
      const headers = {
        'Content-Type': 'application/json',
        'X-Webhook-ID': event.id,
        'X-Webhook-Timestamp': new Date().toISOString(),
        'X-Webhook-Signature': `sha256=${signature}`,
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: event.id,
          type: event.type,
          timestamp: new Date().toISOString(),
          data: event.payload,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        // Success!
        event.status = WebhookStatus.DELIVERED;
        event.httpStatus = response.status;
        webhook.lastTriggeredAt = new Date();
        webhook.failureCount = 0;
        this.webhookEvents.set(event.id, event);
        this.webhooks.set(webhook.id, webhook);
      } else {
        // HTTP error
        await this.scheduleRetry(event, webhook, response.status);
      }
    } catch (error) {
      // Network error, connection timeout, etc.
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.scheduleRetry(event, webhook, 0, errorMessage);
    }
  }

  /**
   * Schedule retry for failed event
   */
  private async scheduleRetry(
    event: WebhookEvent,
    webhook: Webhook,
    httpStatus: number,
    errorMessage?: string
  ): Promise<void> {
    event.attempt += 1;
    event.httpStatus = httpStatus;
    event.errorMessage = errorMessage;

    if (event.attempt > this.maxAttempts) {
      // Max attempts reached
      event.status = WebhookStatus.FAILED;
      webhook.failureCount += 1;
      if (webhook.failureCount >= 5) {
        // Disable webhook after 5 consecutive failures
        webhook.isActive = false;
      }
    } else {
      // Schedule next retry
      const delayIndex = Math.min(
        event.attempt - 2,
        this.retryDelays.length - 1
      );
      const delay = this.retryDelays[delayIndex];
      event.nextRetryAt = new Date(Date.now() + delay);
      event.status = WebhookStatus.PENDING;
    }

    this.webhookEvents.set(event.id, event);
    this.webhooks.set(webhook.id, webhook);
  }

  /**
   * Process pending events (call periodically)
   */
  async processPendingEvents(): Promise<void> {
    const now = new Date();
    const pendingEvents = Array.from(this.webhookEvents.values()).filter(
      (e) =>
        e.status === WebhookStatus.PENDING &&
        e.nextRetryAt &&
        e.nextRetryAt <= now
    );

    for (const event of pendingEvents) {
      const webhook = this.getWebhook(event.webhookId);
      if (webhook) {
        await this.deliverEvent(event, webhook);
      }
    }
  }

  /**
   * Sign webhook payload using HMAC-SHA256
   */
  private signPayload(payload: Record<string, any>, secret: string): string {
    const message = JSON.stringify(payload);
    return crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('hex');
  }

  /**
   * Verify webhook signature (for webhook receiver validation)
   */
  static verifySignature(
    payload: string,
    signature: string,
    secret: string
  ): boolean {
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
    return signature === expectedSignature;
  }

  /**
   * Get webhook events
   */
  getWebhookEvents(webhookId: string, limit = 100): WebhookEvent[] {
    return Array.from(this.webhookEvents.values())
      .filter((e) => e.webhookId === webhookId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  /**
   * Test webhook delivery
   */
  async testWebhook(webhookId: string): Promise<void> {
    const webhook = this.getWebhook(webhookId);
    if (!webhook) {
      throw new AppError('Webhook not found', ErrorCode.NOT_FOUND, 404);
    }

    const testPayload = {
      test: true,
      timestamp: new Date().toISOString(),
      message: 'This is a test webhook delivery',
    };

    await this.deliverEvent(
      {
        id: `evt_test_${Date.now()}`,
        webhookId,
        type: 'test',
        payload: testPayload,
        status: WebhookStatus.PENDING,
        attempt: 1,
        createdAt: new Date(),
      },
      webhook
    );
  }
}

// Singleton instance
let webhookService: WebhookService | null = null;

export function getWebhookService(): WebhookService {
  if (!webhookService) {
    webhookService = new WebhookService();
    // Start periodic event processing
    setInterval(() => {
      webhookService?.processPendingEvents().catch((err) =>
        console.error('Error processing webhook events:', err)
      );
    }, 30 * 1000); // Every 30 seconds
  }
  return webhookService;
}
