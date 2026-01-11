import { logger } from '../utils/logger';
import { NotificationService } from './NotificationService';
import { MessageQueue } from '../config/messageQueue';
import {
  NotificationEvent,
  UserFollowedEvent,
  CommentCreatedEvent,
  MentionCreatedEvent,
  LikeCreatedEvent,
  validateEvent,
  isUserFollowedEvent,
  isCommentCreatedEvent,
  isMentionCreatedEvent,
  isLikeCreatedEvent,
  EventMetadata,
  EventProcessingResult,
} from '../events.schema';
import { RedisCache } from '../config/redis';
import UserPreferences from '../models/UserPreferences';
import { idempotencyService, generateIdempotencyKey } from './IdempotencyService';

export class EventHandlerService {
  private notificationService: NotificationService;
  private isInitialized = false;
  private processedEvents = new Set<string>(); // For idempotency

  constructor() {
    this.notificationService = new NotificationService();
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      await this.notificationService.initialize();
      await this.startEventConsumer();
      
      this.isInitialized = true;
      logger.info('✅ EventHandlerService initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize EventHandlerService:', error);
      throw error;
    }
  }

  private async startEventConsumer(): Promise<void> {
    try {
      // Listen for notification events
      await MessageQueue.consume('notification.events', async (message) => {
        return await this.processNotificationEvent(message);
      });
      
      logger.info('👂 Started consuming notification events');
    } catch (error) {
      logger.error('❌ Error setting up event consumer:', error);
      throw error;
    }
  }

  async processNotificationEvent(eventData: any): Promise<boolean> {
    // Extract or generate correlation ID for distributed tracing
    const correlationId = eventData.correlationId || 
                          eventData.traceId || 
                          `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const metadata: EventMetadata = {
      eventId: eventData.eventId || 'unknown',
      receivedAt: new Date(),
      source: 'message-queue',
      retryCount: eventData.retryCount || 0,
      correlationId,
      traceId: eventData.traceId,
      spanId: eventData.spanId,
    };

    try {
      // Validate event schema
      const event = validateEvent(eventData);
      metadata.eventId = event.eventId;

      // Log with correlation ID for distributed tracing
      logger.info(`📨 Processing ${event.eventType} event: ${event.eventId}`, {
        correlationId,
        eventType: event.eventType,
        eventId: event.eventId,
      });

      // Check for idempotency
      if (await this.isEventProcessed(event.eventId)) {
        logger.info(`🔄 Event ${event.eventId} already processed, skipping`, { correlationId });
        return true;
      }

      // Process the event based on type, passing correlation ID
      const result = await this.handleEventByType(event, correlationId);
      
      if (result.success) {
        // Mark as processed for idempotency (with eventType for better tracing)
        await this.markEventProcessed(event.eventId, result.notificationId, event.eventType);
        
        // Publish processing success event with correlation ID
        await this.publishEventProcessed(event, result, correlationId);
        
        metadata.processedAt = new Date();
        logger.info(`✅ Successfully processed event ${event.eventId} -> notification ${result.notificationId}`, {
          correlationId,
          eventId: event.eventId,
          notificationId: result.notificationId,
          durationMs: Date.now() - metadata.receivedAt.getTime(),
        });
      } else {
        logger.error(`❌ Failed to process event ${event.eventId}: ${result.error}`, {
          correlationId,
          error: result.error,
        });
        metadata.errors = [result.error || 'Unknown error'];
      }

      return result.success;

    } catch (error) {
      logger.error(`❌ Error processing event ${metadata.eventId}:`, {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
      metadata.errors = [error instanceof Error ? error.message : String(error)];
      return false;
    }
  }

  private async handleEventByType(event: NotificationEvent, correlationId?: string): Promise<EventProcessingResult> {
    try {
      if (isUserFollowedEvent(event)) {
        return await this.handleUserFollowedEvent(event as any, correlationId);
      } else if (isCommentCreatedEvent(event)) {
        return await this.handleCommentCreatedEvent(event, correlationId);
      } else if (isMentionCreatedEvent(event)) {
        return await this.handleMentionCreatedEvent(event, correlationId);
      } else if (isLikeCreatedEvent(event)) {
        return await this.handleLikeCreatedEvent(event, correlationId);
      } else {
        return {
          success: false,
          eventId: (event as any)?.eventId || '',
          error: `Unknown event type: ${(event as any).eventType}`,
          retryable: false,
          correlationId,
        };
      }
    } catch (error) {
      return {
        success: false,
        eventId: (event as any)?.eventId || '',
        error: error instanceof Error ? error.message : String(error) || '',
        retryable: true,
        correlationId,
      };
    }
  }
  private async handleLikeCreatedEvent(event: LikeCreatedEvent, correlationId?: string): Promise<EventProcessingResult> {
    try {
      logger.info(`👍 Processing like created event: ${event.likerId} -> ${event.targetType} ${event.targetId}`, { correlationId });

      // Check user preferences
      const shouldSend = await this.checkUserPreferences(event.targetOwnerId, 'like');
      if (!shouldSend) {
        return {
          success: true,
          eventId: event.eventId,
          notificationId: 'skipped-by-preference',
          error: '',
          retryable: false,
          correlationId,
        };
      }

      const notificationRequest = {
        userId: event.targetOwnerId, // Notify the owner of the post/comment
        title: 'Someone liked your content',
        body: `Your ${event.targetType} was liked!`,
        category: 'social',
        priority: 'normal' as const,
        data: {
          eventId: event.eventId,
          likerId: event.likerId,
          targetType: event.targetType,
          targetId: event.targetId,
          actionUrl: event.actionUrl,
          eventType: event.eventType,
        },
        source: 'content-service',
        metadata: {
          originalEvent: event,
          eventId: event.eventId,
          resourceId: `${event.likerId}-${event.targetId}`, // For idempotency: unique per liker+target
          correlationId,
        },
      };

      const result = await this.notificationService.sendNotification(notificationRequest);

      return {
        success: result.status === 'success',
        eventId: event.eventId,
        notificationId: result.notificationId,
        error: result.status === 'success' ? '' : (result.message ? result.message : ''),
        retryable: result.status === 'failed',
        correlationId,
      };

    } catch (error) {
      return {
        success: false,
        eventId: event.eventId,
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
        correlationId,
      };
    }
  }

  private async handleUserFollowedEvent(event: UserFollowedEvent, correlationId?: string): Promise<EventProcessingResult> {
    try {
      logger.info(`👥 Processing user followed event: ${event.followerId} -> ${event.followeeId}`, { correlationId });

      // Check user preferences
      const shouldSend = await this.checkUserPreferences((event as any).followeeId, 'follow');
      if (!shouldSend) {
        return {
          success: true,
          eventId: (event as any).eventId,
          notificationId: 'skipped-by-preference',
          error: '',
          retryable: false,
          correlationId,
        };
      }

      const notificationRequest = {
        userId: (event as any).followeeId, // Notify the user being followed
        title: 'New Follower',
        body: 'Someone started following you!',
        category: 'social',
        priority: 'normal' as const,
        data: {
          eventId: (event as any).eventId,
          followerId: (event as any).followerId,
          actionUrl: (event as any).actionUrl,
          eventType: (event as any).eventType,
        },
        source: 'user-service',
        metadata: {
          originalEvent: event,
          eventId: (event as any).eventId,
          resourceId: (event as any).followerId, // For idempotency: unique per follower
          correlationId,
        },
      };

      const result = await this.notificationService.sendNotification(notificationRequest);

      return {
        success: result.status === 'success',
        eventId: (event as any).eventId,
        notificationId: result.notificationId,
        error: result.status === 'success' ? '' : (result.message ? result.message : ''),
        retryable: result.status === 'failed',
        correlationId,
      };

    } catch (error) {
      return {
        success: false,
        eventId: (event as any)?.eventId || '',
        error: error instanceof Error ? error.message : String(error) || '',
        retryable: true,
        correlationId,
      };
    }
  }

  private async handleCommentCreatedEvent(event: CommentCreatedEvent, correlationId?: string): Promise<EventProcessingResult> {
    try {
      logger.info(`💬 Processing comment created event: ${event.commenterId} -> post ${event.postId}`, { correlationId });

      // Check user preferences
      const shouldSend = await this.checkUserPreferences(event.postOwnerId, 'comment');
      if (!shouldSend) {
        return {
          success: true,
          eventId: event.eventId,
          notificationId: 'skipped-by-preference',
          error: '',
          retryable: false,
          correlationId,
        };
      }

      const notificationRequest = {
        userId: event.postOwnerId, // Notify the post owner
        title: 'New Comment',
        body: `Someone commented on your post: "${event.commentText}"`,
        category: 'social',
        priority: 'normal' as const,
        data: {
          eventId: event.eventId,
          commenterId: event.commenterId,
          postId: event.postId,
          actionUrl: event.actionUrl,
          eventType: event.eventType,
        },
        source: 'content-service',
        metadata: {
          originalEvent: event,
          eventId: event.eventId,
          resourceId: event.postId, // For idempotency: unique per comment on post
          correlationId,
        },
      };

      const result = await this.notificationService.sendNotification(notificationRequest);

      return {
        success: result.status === 'success',
        eventId: event.eventId,
        notificationId: result.notificationId,
        error: result.status === 'success' ? '' : (result.message ? result.message : ''),
        retryable: result.status === 'failed',
        correlationId,
      };

    } catch (error) {
      return {
        success: false,
        eventId: event.eventId,
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
        correlationId,
      };
    }
  }

  private async handleMentionCreatedEvent(event: MentionCreatedEvent, correlationId?: string): Promise<EventProcessingResult> {
    try {
      logger.info(`🏷️ Processing mention created event: ${event.mentionerId} -> ${event.mentionedUserId}`, { correlationId });
      // Check user preferences
      const shouldSend = await this.checkUserPreferences(event.mentionedUserId, 'mention');
      if (!shouldSend) {
        return {
          success: true,
          eventId: event.eventId,
          notificationId: 'skipped-by-preference',
          error: '',
          retryable: false,
          correlationId,
        };
      }
      const notificationRequest = {
        userId: event.mentionedUserId, // Notify the mentioned user
        title: 'You were mentioned',
        body: `You were mentioned in a ${event.contextType}: "${event.mentionText}"`,
        category: 'social',
        priority: 'high' as const, // Mentions are higher priority
        data: {
          eventId: event.eventId,
          mentionerId: event.mentionerId,
          contextType: event.contextType,
          contextId: event.contextId,
          actionUrl: event.actionUrl,
          eventType: event.eventType,
        },
        source: 'content-service',
        metadata: {
          originalEvent: event,
          eventId: event.eventId,
          resourceId: event.contextId, // For idempotency: unique per mention context
          correlationId,
        },
      };

      const result = await this.notificationService.sendNotification(notificationRequest);

      return {
        success: result.status === 'success',
        eventId: event.eventId,
        notificationId: result.notificationId,
        error: result.status === 'success' ? '' : (result.message ? result.message : ''),
        retryable: result.status === 'failed',
        correlationId,
      };

    } catch (error) {
      return {
        success: false,
        eventId: event.eventId,
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
        correlationId,
      };
    }
  }

  /**
   * Check if user has disabled notifications for this type
   * @param userId - User to check preferences for
   * @param notificationType - Type of notification (follow, like, comment, mention, message)
   * @returns true if notification should be sent, false if blocked by preferences
   */
  private async checkUserPreferences(userId: string, notificationType: string): Promise<boolean> {
    try {
      const preferences = await UserPreferences.findOne({ userId });
      
      if (!preferences) {
        // No preferences set, allow by default
        return true;
      }

      // Check notificationTypes field
      if (preferences.notificationTypes && preferences.notificationTypes[notificationType]) {
        const isEnabled = preferences.notificationTypes[notificationType].isEnabled;
        if (!isEnabled) {
          logger.info(`🔕 Notification skipped due to user preference: userId=${userId}, type=${notificationType}`);
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.error('Error checking user preferences:', error);
      // Default to allowing notification on error
      return true;
    }
  }

  private async isEventProcessed(eventId: string): Promise<boolean> {
    try {
      // Use the robust IdempotencyService with Redis + MongoDB fallback
      const idempotencyKey = `event:${eventId}`;
      return await idempotencyService.isProcessed(idempotencyKey);
    } catch (error) {
      logger.error('Error checking event processing status:', error);
      // Fail-open: allow processing on error
      return false;
    }
  }

  private async markEventProcessed(eventId: string, notificationId: string | undefined, eventType: string | undefined): Promise<void> {
    try {
      const idempotencyKey = `event:${eventId}`;
      
      // Use the robust IdempotencyService with dual-write to Redis + MongoDB
      await idempotencyService.markProcessed(idempotencyKey, {
        eventId,
        eventType: eventType || 'unknown',
        ...(notificationId && { notificationId }),
      });
      
      // Also add to in-memory cache for quick checks
      this.processedEvents.add(eventId);
    } catch (error) {
      logger.error('Error marking event as processed:', error);
    }
  }

  private async publishEventProcessed(event: NotificationEvent, result: EventProcessingResult, correlationId?: string): Promise<void> {
    try {
      const processedEvent = {
        eventType: 'notification.event.processed',
        originalEventId: event.eventId,
        originalEventType: event.eventType,
        notificationId: result.notificationId,
        processedAt: new Date().toISOString(),
        success: result.success,
        error: result.error,
        correlationId,
      };

      await MessageQueue.publish('notification.events.processed', processedEvent);
    } catch (error) {
      logger.error('Error publishing event processed notification:', { correlationId, error });
    }
  }

  // Manual event processing for testing or replay
  async processEvent(event: NotificationEvent, correlationId?: string): Promise<EventProcessingResult> {
    const traceId = correlationId || `manual_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    logger.info(`🔄 Manually processing ${event.eventType} event: ${event.eventId}`, { correlationId: traceId });
    
    try {
      validateEvent(event);
      return await this.handleEventByType(event, traceId);
    } catch (error) {
      return {
        success: false,
        eventId: event.eventId,
        error: error instanceof Error ? error.message : String(error),
        retryable: false,
        correlationId: traceId,
      };
    }
  }

  // Get processing statistics
  async getProcessingStats(): Promise<{
    processedEventsCount: number;
    recentEvents: Array<{ eventId: string; processedAt: string; notificationId?: string }>;
  }> {
    try {
      const redisClient = await import('../config/redis').then(m => m.getRedisClient());
      
      if (!redisClient?.isOpen) {
        return { processedEventsCount: 0, recentEvents: [] };
      }

      const keys = await redisClient.keys('processed_event:*');
      const recentEvents: Array<{ eventId: string; processedAt: string; notificationId?: string }> = [];

      for (const key of keys.slice(0, 10)) { // Get last 10
        try {
          const data = await redisClient.get(key);
          if (data) {
            recentEvents.push(JSON.parse(data));
          }
        } catch (error) {
          logger.warn(`Error reading processed event ${key}:`, error);
        }
      }

      return {
        processedEventsCount: keys.length,
        recentEvents: recentEvents.sort((a, b) => 
          new Date(b.processedAt).getTime() - new Date(a.processedAt).getTime()
        ),
      };
    } catch (error) {
      logger.error('Error getting processing stats:', error);
      return { processedEventsCount: 0, recentEvents: [] };
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.notificationService.shutdown();
      this.processedEvents.clear();
      this.isInitialized = false;
      
      logger.info('✅ EventHandlerService shut down successfully');
    } catch (error) {
      logger.error('❌ Error shutting down EventHandlerService:', error);
      throw error;
    }
  }
}