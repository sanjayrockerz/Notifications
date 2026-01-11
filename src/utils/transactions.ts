/**
 * MongoDB Transaction Helper
 * 
 * Provides a clean interface for running operations within MongoDB transactions.
 * Ensures proper session management and error handling.
 * 
 * WHEN TO USE TRANSACTIONS:
 * 1. Outbox pattern: Write notification + outbox event atomically
 * 2. Multi-document updates: Mark many notifications as read
 * 3. Counter updates: Decrement unread count when marking as read
 * 
 * REQUIREMENTS:
 * - MongoDB 4.0+ with replica set or sharded cluster
 * - Cannot use transactions with standalone MongoDB (development mode)
 * 
 * RETRY STRATEGY:
 * - Transient errors (e.g., write conflicts) are retried automatically
 * - Max 3 retries with exponential backoff
 */

import mongoose, { ClientSession } from 'mongoose';
import { logger } from '../utils/logger';

// ============================================================================
// Transaction Configuration
// ============================================================================

export interface TransactionOptions {
  /** Maximum number of retries for transient errors */
  maxRetries?: number;
  /** Read concern level */
  readConcern?: 'local' | 'majority' | 'linearizable' | 'snapshot';
  /** Write concern level */
  writeConcern?: {
    w?: number | 'majority';
    j?: boolean;
    wtimeout?: number;
  };
  /** Read preference */
  readPreference?: 'primary' | 'primaryPreferred' | 'secondary' | 'secondaryPreferred' | 'nearest';
}

const DEFAULT_OPTIONS: TransactionOptions = {
  maxRetries: 3,
  readConcern: 'majority',
  writeConcern: { w: 'majority', j: true },
  readPreference: 'primary',
};

// ============================================================================
// Transaction Execution
// ============================================================================

/**
 * Check if transactions are supported in the current MongoDB deployment
 */
export function isTransactionSupported(): boolean {
  // Transactions require replica set or sharded cluster
  // In development with standalone MongoDB, transactions won't work
  const uri = process.env.MONGODB_URI || '';
  return (
    uri.includes('replicaSet=') ||
    uri.includes('mongodb+srv://') || // Atlas always supports transactions
    process.env.MONGODB_SUPPORTS_TRANSACTIONS === 'true'
  );
}

/**
 * Execute a function within a MongoDB transaction
 * 
 * @param fn - Function to execute (receives session as parameter)
 * @param options - Transaction options
 * @returns Result of the function
 * @throws Error if transaction fails after all retries
 * 
 * @example
 * const result = await withTransaction(async (session) => {
 *   const notification = await Notification.create([data], { session });
 *   await OutboxEvent.create([eventData], { session });
 *   return notification[0];
 * });
 */
export async function withTransaction<T>(
  fn: (session: ClientSession) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  // Check if transactions are supported
  if (!isTransactionSupported()) {
    logger.warn('Transactions not supported - running without transaction');
    // Create a mock session for non-transactional execution
    const session = await mongoose.startSession();
    try {
      return await fn(session);
    } finally {
      await session.endSession();
    }
  }
  
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= (opts.maxRetries || 3); attempt++) {
    const session = await mongoose.startSession();
    
    try {
      session.startTransaction({
        readConcern: { level: opts.readConcern || 'majority' },
        ...(opts.writeConcern && { writeConcern: opts.writeConcern }),
        ...(opts.readPreference && { readPreference: opts.readPreference }),
      });
      
      const result = await fn(session);
      
      await session.commitTransaction();
      
      logger.debug('Transaction committed successfully', { attempt });
      
      return result;
      
    } catch (error: any) {
      await session.abortTransaction();
      lastError = error;
      
      // Check if error is transient (retryable)
      if (isTransientError(error) && attempt < (opts.maxRetries || 3)) {
        logger.warn(`Transient transaction error, retrying (attempt ${attempt}/${opts.maxRetries})`, {
          error: error.message,
          code: error.code,
        });
        
        // Exponential backoff
        await sleep(Math.pow(2, attempt) * 100);
        continue;
      }
      
      logger.error('Transaction failed', {
        attempt,
        error: error.message,
        code: error.code,
      });
      
      throw error;
      
    } finally {
      await session.endSession();
    }
  }
  
  throw lastError || new Error('Transaction failed after all retries');
}

/**
 * Run a callback with an existing session (for nested transactions)
 * If no session is provided, creates a new transaction
 */
export async function withOptionalTransaction<T>(
  fn: (session: ClientSession) => Promise<T>,
  existingSession?: ClientSession,
  options?: TransactionOptions
): Promise<T> {
  if (existingSession) {
    // Already in a transaction, just run the function
    return fn(existingSession);
  }
  
  // Create new transaction
  return withTransaction(fn, options);
}

// ============================================================================
// Transaction Decorators (for class methods)
// ============================================================================

/**
 * Decorator to wrap a method in a transaction
 * 
 * @example
 * class NotificationService {
 *   @Transactional()
 *   async createNotification(data: any, session?: ClientSession) {
 *     // Method body runs in transaction
 *   }
 * }
 */
export function Transactional(options?: TransactionOptions) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function (...args: any[]) {
      // Check if session is already passed as last argument
      const lastArg = args[args.length - 1];
      if (lastArg && lastArg.startTransaction) {
        // Session already provided, run without new transaction
        return originalMethod.apply(this, args);
      }
      
      // Wrap in transaction
      return withTransaction(async (session) => {
        args.push(session);
        return originalMethod.apply(this, args);
      }, options);
    };
    
    return descriptor;
  };
}

// ============================================================================
// Outbox-Specific Transaction Helper
// ============================================================================

import OutboxEvent, { IOutboxEvent } from '../models/OutboxEvent';
import { v4 as uuidv4 } from 'uuid';

export interface OutboxWriteOptions {
  session: ClientSession;
  eventType: string;
  payload: Record<string, any>;
  correlationId?: string;
}

/**
 * Write to outbox table within a transaction
 * Use this when you need to atomically save a document and create an outbox event
 */
export async function writeToOutbox(
  options: OutboxWriteOptions
): Promise<IOutboxEvent> {
  const { session, eventType, payload, correlationId } = options;
  
  const eventId = payload.eventId || uuidv4();
  const outboxId = uuidv4();
  
  const outboxEntry = new OutboxEvent({
    outboxId,
    eventId,
    eventType,
    payload: {
      ...payload,
      eventId,
      correlationId,
      timestamp: new Date().toISOString(),
    },
    published: false,
    createdAt: new Date(),
    retryCount: 0,
  });
  
  await outboxEntry.save({ session });
  
  logger.debug('Outbox entry created within transaction', {
    outboxId,
    eventId,
    eventType,
    correlationId,
  });
  
  return outboxEntry;
}

/**
 * Create a document and its corresponding outbox event atomically
 * 
 * @example
 * const notification = await createWithOutbox(
 *   Notification,
 *   notificationData,
 *   {
 *     eventType: 'notification.created',
 *     payload: notificationData,
 *   }
 * );
 */
export async function createWithOutbox<T>(
  Model: mongoose.Model<T>,
  documentData: any,
  outboxOptions: {
    eventType: string;
    payload: Record<string, any>;
    correlationId?: string;
  }
): Promise<T> {
  const result = await withTransaction(async (session) => {
    // Create the main document
    const [document] = await Model.create([documentData], { session });
    
    // Create the outbox event
    await writeToOutbox({
      session,
      eventType: outboxOptions.eventType,
      payload: {
        ...outboxOptions.payload,
        documentId: (document as any)._id?.toString(),
      },
      ...(outboxOptions.correlationId && { correlationId: outboxOptions.correlationId }),
    });
    
    return document as T;
  });
  
  return result!;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if an error is transient (retryable)
 */
function isTransientError(error: any): boolean {
  // MongoDB transient error codes
  const transientCodes = [
    11000, // Duplicate key (can happen during retries)
    112,   // WriteConflict
    251,   // TransactionAborted
  ];
  
  if (transientCodes.includes(error.code)) {
    return true;
  }
  
  // Check for transient transaction error label
  if (error.hasErrorLabel && error.hasErrorLabel('TransientTransactionError')) {
    return true;
  }
  
  return false;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Batch Operations with Transaction
// ============================================================================

/**
 * Run a batch operation with transaction support
 * Useful for bulk updates that need atomicity
 */
export async function batchWithTransaction<T, R>(
  items: T[],
  batchSize: number,
  processor: (batch: T[], session: ClientSession) => Promise<R[]>
): Promise<R[]> {
  const results: R[] = [];
  
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    
    const batchResults = await withTransaction(async (session) => {
      return processor(batch, session);
    });
    
    results.push(...batchResults);
  }
  
  return results;
}
