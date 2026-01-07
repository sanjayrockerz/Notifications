import * as amqp from 'amqplib';
import { logger } from '../utils/logger';

interface MessageQueueConfig {
  url: string;
  exchangeName: string;
  queueName: string;
  consumerGroup?: string; // For horizontal scaling
  prefetchCount: number; // Messages to fetch per worker
  options: {
    durable: boolean;
    persistent: boolean;
  };
}

const config: MessageQueueConfig = {
  url: process.env.RABBITMQ_URL || 'amqp://localhost:5672',
  exchangeName: process.env.EXCHANGE_NAME || 'notifications',
  queueName: process.env.QUEUE_NAME || 'notification_queue',
  consumerGroup: process.env.CONSUMER_GROUP || 'notification-workers',
  prefetchCount: parseInt(process.env.PREFETCH_COUNT || '10', 10), // 10 messages per worker
  options: {
    durable: true,
    persistent: true,
  },
};

let connection: any = null;
let channel: any = null;

export const connectMessageQueue = async (): Promise<void> => {
  try {
    // Create connection
    connection = await amqp.connect(config.url, {
      heartbeat: 60,
      timeout: 10000,
    });

    logger.info('✅ RabbitMQ connection established');

    // Create channel
    channel = await connection.createChannel();
    
    // Set prefetch for load distribution across multiple consumers
    // Each worker will fetch up to prefetchCount messages
    await channel.prefetch(config.prefetchCount);
    
    logger.info(`✅ Channel prefetch set to ${config.prefetchCount} (supports parallel workers)`);

    // Declare exchange
    await channel.assertExchange(config.exchangeName, 'topic', {
      durable: config.options.durable,
    });

    // Declare main queue
    await channel.assertQueue(config.queueName, {
      durable: config.options.durable,
    });

    // Declare dead letter queue
    const dlqName = `${config.queueName}.dlq`;
    await channel.assertQueue(dlqName, {
      durable: config.options.durable,
    });

    // Bind queue to exchange
    await channel.bindQueue(config.queueName, config.exchangeName, 'notification.*');

    logger.info('✅ RabbitMQ channel and queues configured');

    // Connection error handlers
    if (connection) {
      connection.on('error', (error: any) => {
        logger.error('❌ RabbitMQ connection error:', error);
      });
      connection.on('error', (error: any) => {
        logger.error('❌ RabbitMQ connection error:', error);
      });

      connection.on('close', () => {
        logger.warn('⚠️ RabbitMQ connection closed');
        connection = null;
        channel = null;
      });
    }

    if (channel) {
      channel.on('error', (error: any) => {
        logger.error('❌ RabbitMQ channel error:', error);
      });
      channel.on('error', (error: any) => {
        logger.error('❌ RabbitMQ channel error:', error);
      });

      channel.on('close', () => {
        logger.warn('⚠️ RabbitMQ channel closed');
        channel = null;
      });
    }

  } catch (error) {
    logger.error('❌ Failed to connect to RabbitMQ:', error);
    connection = null;
    channel = null;
    throw error;
  }
};

export const disconnectMessageQueue = async (): Promise<void> => {
  try {
    if (channel) {
      await channel.close();
      channel = null;
    }
    if (connection) {
      await connection.close();
      connection = null;
    }
    logger.info('✅ RabbitMQ disconnected successfully');
  } catch (error) {
    logger.error('❌ Error disconnecting from RabbitMQ:', error);
    throw error;
  }
};

export const getChannel = () => channel;

export const isMessageQueueConnected = (): boolean => {
  return connection !== null && channel !== null;
};

// Message Queue utility functions
export class MessageQueue {
  static async publish(routingKey: string, message: any, options?: any): Promise<boolean> {
    try {
      if (!channel) {
        logger.error('❌ RabbitMQ channel not available');
        return false;
      }

      const messageBuffer = Buffer.from(JSON.stringify(message));
      const publishOptions = {
        persistent: config.options.persistent,
        timestamp: Date.now(),
        messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        ...options,
      };

      const success = channel.publish(
        config.exchangeName,
        routingKey,
        messageBuffer,
        publishOptions
      );

      if (success) {
        logger.info(`📤 Message published to ${routingKey}`);
      } else {
        logger.warn(`⚠️ Failed to publish message to ${routingKey}`);
      }

      return success;
    } catch (error) {
      logger.error('❌ Error publishing message:', error);
      return false;
    }
  }

  static async consume(
    queueName: string,
    callback: (message: any) => Promise<boolean>,
    options?: {
      prefetchCount?: number; // Number of messages to prefetch (default: 1)
      consumerTag?: string; // Consumer identifier for consumer groups
      noAck?: boolean; // Auto-acknowledge messages (default: false)
    }
  ): Promise<void> {
    try {
      if (!channel) {
        logger.error('❌ RabbitMQ channel not available');
        throw new Error('RabbitMQ channel not available');
      }

      // Set prefetch count for this consumer (for load distribution)
      const prefetchCount = options?.prefetchCount || 1;
      await channel.prefetch(prefetchCount);

      await channel.consume(
        queueName,
        async (msg: any) => {
          if (!msg) return;

          try {
            const messageContent = JSON.parse(msg.content.toString());
            logger.info(`📥 Processing message from ${queueName}`, {
              consumerTag: options?.consumerTag,
            });

            const success = await callback(messageContent);
            if (success) {
              if (!options?.noAck) {
                channel.ack(msg);
              }
              logger.info('✅ Message processed successfully');
            } else {
              if (!options?.noAck) {
                channel.nack(msg, false, false); // Send to DLQ
              }
              logger.warn('⚠️ Message processing failed, sent to DLQ');
            }
          } catch (error) {
            logger.error('❌ Error processing message:', error);
            if (!options?.noAck) {
              channel.nack(msg, false, false); // Send to DLQ
            }
          }
        },
        {
          noAck: options?.noAck || false,
          consumerTag: options?.consumerTag,
        }
      );

      logger.info(`👂 Started consuming messages from ${queueName}`, {
        prefetchCount,
        consumerTag: options?.consumerTag,
      });
    } catch (error) {
      logger.error('❌ Error setting up message consumer:', error);
      throw error;
    }
  }

  /**
   * Create a consumer group for horizontal scaling
   * Multiple consumers can consume from the same queue, RabbitMQ distributes messages
   */
  static async consumeWithGroup(
    queueName: string,
    consumerGroupId: string,
    consumerIndex: number,
    callback: (message: any) => Promise<boolean>,
    prefetchCount: number = 10
  ): Promise<void> {
    const consumerTag = `${consumerGroupId}-consumer-${consumerIndex}`;
    
    logger.info(`📡 Starting consumer in group: ${consumerGroupId}, index: ${consumerIndex}`);
    
    await this.consume(queueName, callback, {
      prefetchCount,
      consumerTag,
    });
  }

  static async sendToQueue(queueName: string, message: any): Promise<boolean> {
    try {
      if (!channel) {
        logger.error('❌ RabbitMQ channel not available');
        return false;
      }

      const messageBuffer = Buffer.from(JSON.stringify(message));
      const success = channel.sendToQueue(queueName, messageBuffer, {
        persistent: config.options.persistent,
      });

      return success;
    } catch (error) {
      logger.error('❌ Error sending message to queue:', error);
      return false;
    }
  }
}