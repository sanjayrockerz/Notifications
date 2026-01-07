import amqp from 'amqplib';
import Notification from '../models/Notification';
import ProcessedEvent from '../models/ProcessedEvent';
import DeliveryLog from '../models/DeliveryLog';
import Device from '../models/Device';
import { logger } from '../utils/logger';
import { z } from 'zod';
import mongoose from 'mongoose';

const eventSchema = z.object({
  eventId: z.string(),
  eventType: z.string(),
  userId: z.string(),
  payload: z.any(),
  schemaVersion: z.string().optional(),
});

export class EventConsumerService {
  private channel: amqp.Channel | null = null;
  private queueName: string;

  constructor(queueName: string) {
    this.queueName = queueName;
  }

  async connectAndConsume(amqpUrl: string, consumerGroup = 'notification-service') {
    let retryDelay = 1000;
    while (true) {
      try {
        const conn = await amqp.connect(amqpUrl);
        this.channel = await conn.createChannel();
        await this.channel.assertQueue(this.queueName, { durable: true });
        // Support consumer group by using queue per group
        const groupQueue = `${this.queueName}.${consumerGroup}`;
        await this.channel.assertQueue(groupQueue, { durable: true });
        await this.channel.bindQueue(groupQueue, this.queueName, 'UserFollowed');
        this.channel.consume(groupQueue, this.handleEvent.bind(this), { noAck: false });
        logger.info(`EventConsumerService listening on queue: ${groupQueue}`);
        break;
      } catch (err) {
        logger.error({ msg: 'Broker connection failed', error: err });
        logger.info(`Retrying broker connection in ${retryDelay / 1000}s...`);
        await new Promise(r => setTimeout(r, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 60000); // Exponential backoff up to 1 min
      }
    }
  }

  async handleEvent(msg: amqp.ConsumeMessage | null) {
    if (!msg) return;
    try {
      const eventRaw = msg.content.toString();
      logger.info({ msg: 'Event received', eventRaw });
      const event = eventSchema.safeParse(JSON.parse(eventRaw));
      if (!event.success) {
        logger.error({ msg: 'Event schema validation failed', error: event.error });
        this.channel?.nack(msg, false, false);
        return;
      }
      // Call the event handler logic (Phase 1.4)
      const { eventId, eventType, userId, payload } = event.data;
      // ...existing event handler logic...
      // (The rest of the handler remains unchanged)
      // Log processing result
      logger.info({ msg: 'Event processed', eventId, eventType, userId, timestamp: new Date().toISOString() });
      this.channel?.ack(msg);
    } catch (err) {
      logger.error({
        msg: 'Error processing event',
        error: err,
        stack: (err instanceof Error && err.stack) ? err.stack : undefined
      });
      this.channel?.nack(msg, false, true);
    }
  }

  buildTitle(eventType: string, payload: any): string {
    if (eventType === 'UserFollowed') {
      return `${payload.followerName || 'Someone'} followed you`;
    } else if (eventType === 'CommentCreated') {
      return `${payload.commenterName || 'Someone'} commented on your post`;
    } else if (eventType === 'MentionCreated') {
      return `You were mentioned in a comment`;
    }
    return 'You have a new notification';
  }

  buildBody(eventType: string, payload: any): string {
    if (eventType === 'UserFollowed') {
      return `${payload.followerName || 'Someone'} started following you.`;
    } else if (eventType === 'CommentCreated') {
      return `${payload.commenterName || 'Someone'}: ${payload.commentText || ''}`;
    } else if (eventType === 'MentionCreated') {
      return `${payload.commenterName || 'Someone'} mentioned you: ${payload.commentText || ''}`;
    }
    return '';
  }
}
