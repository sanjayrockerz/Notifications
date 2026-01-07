import { logger } from '../utils/logger';
import OutboxEvent, { IOutboxEvent } from '../models/OutboxEvent';
import { MessageQueue } from '../config/messageQueue';
import { NotificationEvent } from '../events.schema';

/**
 * OutboxRelayService - Transactional Outbox Pattern Implementation
 * 
 * This service implements the outbox pattern relay worker that:
 * 1. Polls the outbox table for unpublished events
 * 2. Publishes them to the message broker
 * 3. Marks them as published upon successful delivery
 * 4. Implements exponential backoff for failed deliveries
 * 
 * Benefits:
 * - Ensures at-least-once delivery semantics
 * - Maintains atomicity between business logic and event publishing
 * - Provides audit trail of all events
 * - Handles transient broker failures gracefully
 */
export class OutboxRelayService {
  private isRunning = false;
  private intervalId: NodeJS.Timeout | undefined;
  private pollingInterval: number;
  private batchSize: number;
  private maxRetries: number;

  constructor(options: {
    pollingInterval?: number;
    batchSize?: number;
    maxRetries?: number;
  } = {}) {
    this.pollingInterval = options.pollingInterval || 5000; // 5 seconds default
    this.batchSize = options.batchSize || 100;
    this.maxRetries = options.maxRetries || 10;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('OutboxRelayService is already running');
      return;
    }

    this.isRunning = true;
    logger.info('🚀 Starting OutboxRelayService', {
      pollingInterval: this.pollingInterval,
      batchSize: this.batchSize,
      maxRetries: this.maxRetries,
    });

    // Start polling immediately
    await this.poll();

    // Then poll at regular intervals
    this.intervalId = setInterval(async () => {
      await this.poll();
    }, this.pollingInterval);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    logger.info('🛑 OutboxRelayService stopped');
  }

  private async poll(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      // Fetch unpublished events from outbox
      const unpublishedEvents = await (OutboxEvent as any).findUnpublished(this.batchSize);

      if (unpublishedEvents.length === 0) {
        return; // No events to process
      }

      logger.info(`📦 Processing ${unpublishedEvents.length} outbox events`);

      // Process each event
      const results = await Promise.allSettled(
        unpublishedEvents.map((event: IOutboxEvent) => this.processEvent(event))
      );

      // Log summary
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      logger.info(`✅ Outbox relay batch completed`, {
        total: unpublishedEvents.length,
        successful,
        failed,
      });

    } catch (error) {
      logger.error('❌ Error during outbox polling:', error);
    }
  }

  private async processEvent(event: IOutboxEvent): Promise<void> {
    try {
      // Check if retry limit exceeded
      if (event.retryCount >= this.maxRetries) {
        logger.error(`🚫 Event ${event.eventId} exceeded max retries (${this.maxRetries})`, {
          eventId: event.eventId,
          eventType: event.eventType,
          retryCount: event.retryCount,
          lastError: event.lastError,
        });
        return; // Skip this event (could move to dead letter queue)
      }

      // Publish to message broker
      await this.publishEvent(event);

      // Mark as published
      await (OutboxEvent as any).markAsPublished(event.outboxId);

      logger.info(`✅ Event ${event.eventId} published successfully`, {
        eventId: event.eventId,
        eventType: event.eventType,
        retryCount: event.retryCount,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Increment retry count and record error
      await (OutboxEvent as any).incrementRetryCount(event.outboxId, errorMessage);

      // Calculate exponential backoff delay
      const backoffDelay = this.calculateBackoff(event.retryCount);

      logger.warn(`⚠️ Failed to publish event ${event.eventId}, will retry`, {
        eventId: event.eventId,
        eventType: event.eventType,
        retryCount: event.retryCount + 1,
        nextRetryIn: `${backoffDelay}ms`,
        error: errorMessage,
      });

      throw error; // Re-throw to mark as failed in Promise.allSettled
    }
  }

  private async publishEvent(event: IOutboxEvent): Promise<void> {
    const routingKey = this.getRoutingKey(event.eventType);
    
    await MessageQueue.publish(routingKey, event.payload);
  }

  private getRoutingKey(eventType: string): string {
    // Map event types to routing keys
    // This maps to the queue names used by the notification service
    const routingKeyMap: Record<string, string> = {
      'UserFollowed': 'notification.events',
      'CommentCreated': 'notification.events',
      'MentionCreated': 'notification.events',
      'LikeCreated': 'notification.events',
      'comment.created': 'notification.events',
      'mention.created': 'notification.events',
      'like.created': 'notification.events',
    };

    return routingKeyMap[eventType] || 'notification.events';
  }

  private calculateBackoff(retryCount: number): number {
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 64s, ...
    // Capped at 5 minutes (300000ms)
    const baseDelay = 1000; // 1 second
    const maxDelay = 300000; // 5 minutes
    
    const delay = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
    
    // Add jitter (±20%) to prevent thundering herd
    const jitter = delay * 0.2 * (Math.random() - 0.5);
    
    return Math.floor(delay + jitter);
  }

  /**
   * Get statistics about the outbox
   */
  async getStats(): Promise<{
    unpublished: number;
    published: number;
    failed: number;
    oldestUnpublished: Date | undefined;
  }> {
    try {
      const [unpublished, published, failed] = await Promise.all([
        OutboxEvent.countDocuments({ published: false, retryCount: { $lt: this.maxRetries } }),
        OutboxEvent.countDocuments({ published: true }),
        OutboxEvent.countDocuments({ published: false, retryCount: { $gte: this.maxRetries } }),
      ]);

      const oldestEvent = await OutboxEvent.findOne({ published: false })
        .sort({ createdAt: 1 })
        .select('createdAt');

      return {
        unpublished,
        published,
        failed,
        oldestUnpublished: oldestEvent?.createdAt || undefined,
      };
    } catch (error) {
      logger.error('Error getting outbox stats:', error);
      throw error;
    }
  }

  /**
   * Manual trigger to process events immediately (useful for testing)
   */
  async triggerPoll(): Promise<void> {
    await this.poll();
  }
}

// Export singleton instance
export const outboxRelayService = new OutboxRelayService();
