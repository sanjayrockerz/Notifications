import amqp from 'amqplib';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import OutboxEvent from '../models/OutboxEvent';
import mongoose from 'mongoose';

/**
 * EventPublisherService - Transactional Outbox Pattern Implementation
 * 
 * This service has been updated to use the transactional outbox pattern.
 * Instead of publishing directly to the message broker, events are first
 * persisted to the outbox table within the same database transaction as
 * the business logic. This ensures atomicity and at-least-once delivery.
 * 
 * The OutboxRelayService then picks up unpublished events and publishes them.
 */
export class EventPublisherService {
  private channel: amqp.Channel | null = null;
  private exchange: string;
  private useOutbox: boolean;

  constructor(exchange = 'domain-events', useOutbox = true) {
    this.exchange = exchange;
    this.useOutbox = useOutbox;
  }

  async connect(amqpUrl: string) {
    const conn = await amqp.connect(amqpUrl);
    this.channel = await conn.createChannel();
    await this.channel.assertExchange(this.exchange, 'topic', { durable: true });
    logger.info(`EventPublisherService connected to exchange: ${this.exchange}`);
  }

  /**
   * Publish event using transactional outbox pattern
   * This method should be called within a database transaction/session
   */
  async publishEventWithOutbox(
    event: any,
    session?: mongoose.ClientSession
  ): Promise<string> {
    const eventId = event.eventId || uuidv4();
    const outboxId = uuidv4();
    
    const payload = {
      ...event,
      eventId,
      timestamp: new Date().toISOString(),
    };

    try {
      // Insert into outbox table (part of the same transaction)
      const outboxEntry = new OutboxEvent({
        outboxId,
        eventId,
        eventType: event.eventType,
        payload,
        published: false,
        createdAt: new Date(),
        retryCount: 0,
      });

      // Save with session if provided (for transactional consistency)
      if (session) {
        await outboxEntry.save({ session });
      } else {
        await outboxEntry.save();
      }

      logger.info('📝 Event written to outbox', {
        outboxId,
        eventId,
        eventType: event.eventType,
        useSession: !!session,
      });

      return eventId;
    } catch (error) {
      logger.error('❌ Failed to write event to outbox:', error);
      throw error;
    }
  }

  /**
   * Direct publish (bypasses outbox - use only when transactional guarantees not needed)
   * @deprecated Use publishEventWithOutbox for reliability
   */
  async publishEvent(event: any): Promise<string> {
    if (this.useOutbox) {
      logger.warn('⚠️ Using direct publish. Consider using publishEventWithOutbox for reliability.');
    }

    if (!this.channel) throw new Error('AMQP channel not initialized');
    
    const eventId = event.eventId || uuidv4();
    const payload = {
      ...event,
      eventId,
      timestamp: new Date().toISOString(),
    };
    
    try {
      this.channel.publish(
        this.exchange,
        event.eventType,
        Buffer.from(JSON.stringify(payload)),
        { persistent: true }
      );
      logger.info({
        msg: 'Event published directly',
        eventId,
        eventType: event.eventType,
        timestamp: payload.timestamp,
      });
      
      return eventId;
    } catch (err) {
      logger.error({
        msg: 'Failed to publish event',
        eventId,
        eventType: event.eventType,
        error: err,
      });
      throw err; // Re-throw to indicate failure
    }
  }
}
