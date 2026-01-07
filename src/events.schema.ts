import { z } from 'zod';

// Base event interface that all events must implement
export interface BaseEvent {
  eventId: string; // UUID for idempotency
  timestamp: string; // ISO 8601 timestamp
  version: string; // Schema version for evolution
}

// UserFollowed Event Schema
export interface UserFollowedEvent extends BaseEvent {
  eventType: 'user.followed';
  followerId: string; // User ID who follows
  followeeId: string; // User ID being followed
  actionUrl: string; // Navigation link for mobile app
  version: 'v1';
}

// CommentCreated Event Schema
export interface CommentCreatedEvent extends BaseEvent {
  eventType: 'comment.created';
  commenterId: string; // User ID who created comment
  postId: string; // Post being commented on
  postOwnerId: string; // Post owner who gets notified
  commentText: string; // First 100 chars of comment
  actionUrl: string; // Link to post
  version: 'v1';
}

// MentionCreated Event Schema
export interface MentionCreatedEvent extends BaseEvent {
  eventType: 'mention.created';
  mentionerId: string; // User who mentioned someone
  mentionedUserId: string; // User who gets notified
  contextType: 'comment' | 'post'; // Type of content where mention occurred
  contextId: string; // ID of comment or post
  mentionText: string; // Surrounding text with mention
  actionUrl: string; // Navigation link
  version: 'v1';
}

// LikeCreated Event Schema
export interface LikeCreatedEvent extends BaseEvent {
  eventType: 'like.created';
  likerId: string; // User who liked
  targetOwnerId: string; // Owner of post/comment
  targetType: 'post' | 'comment';
  targetId: string; // ID of post or comment
  actionUrl: string; // Navigation link
  version: 'v1';
}

// Union type of all events
export type NotificationEvent = 
  | UserFollowedEvent 
  | CommentCreatedEvent 
  | MentionCreatedEvent
  | LikeCreatedEvent;

// Zod validation schemas for runtime validation
export const BaseEventSchema = z.object({
  eventId: z.string().uuid('Event ID must be a valid UUID'),
  timestamp: z.string().datetime('Timestamp must be a valid ISO 8601 string'),
  version: z.string().regex(/^v\d+$/, 'Version must be in format v1, v2, etc.'),
});

export const UserFollowedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('user.followed'),
  followerId: z.string().min(1, 'Follower ID is required'),
  followeeId: z.string().min(1, 'Followee ID is required'),
  actionUrl: z.string().url('Action URL must be a valid URL'),
  version: z.literal('v1'),
});

export const CommentCreatedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('comment.created'),
  commenterId: z.string().min(1, 'Commenter ID is required'),
  postId: z.string().min(1, 'Post ID is required'),
  postOwnerId: z.string().min(1, 'Post Owner ID is required'),
  commentText: z.string().max(100, 'Comment text must be max 100 characters'),
  actionUrl: z.string().url('Action URL must be a valid URL'),
  version: z.literal('v1'),
});

export const MentionCreatedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('mention.created'),
  mentionerId: z.string().min(1, 'Mentioner ID is required'),
  mentionedUserId: z.string().min(1, 'Mentioned User ID is required'),
  contextType: z.enum(['comment', 'post'], {
    errorMap: () => ({ message: 'Context type must be either comment or post' })
  }),
  contextId: z.string().min(1, 'Context ID is required'),
  mentionText: z.string().min(1, 'Mention text is required'),
  actionUrl: z.string().url('Action URL must be a valid URL'),
  version: z.literal('v1'),
});

export const LikeCreatedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('like.created'),
  likerId: z.string().min(1, 'Liker ID is required'),
  targetOwnerId: z.string().min(1, 'Target Owner ID is required'),
  targetType: z.enum(['post', 'comment']),
  targetId: z.string().min(1, 'Target ID is required'),
  actionUrl: z.string().url('Action URL must be a valid URL'),
  version: z.literal('v1'),
});

// Unified event schema for validation
export const NotificationEventSchema = z.discriminatedUnion('eventType', [
  UserFollowedEventSchema,
  CommentCreatedEventSchema,
  MentionCreatedEventSchema,
  LikeCreatedEventSchema,
]);

// Event validation function
export function validateEvent(event: unknown): NotificationEvent {
  return NotificationEventSchema.parse(event);
}

// Event type guard functions
export function isUserFollowedEvent(event: NotificationEvent): event is UserFollowedEvent {
  return event.eventType === 'user.followed';
}

export function isCommentCreatedEvent(event: NotificationEvent): event is CommentCreatedEvent {
  return event.eventType === 'comment.created';
}

export function isMentionCreatedEvent(event: NotificationEvent): event is MentionCreatedEvent {
  return event.eventType === 'mention.created';
}

export function isLikeCreatedEvent(event: NotificationEvent): event is LikeCreatedEvent {
  return event.eventType === 'like.created';
}

// Event factory functions for creating valid events
export class EventFactory {
  static createUserFollowedEvent(
    followerId: string,
    followeeId: string,
    actionUrl: string,
    eventId?: string
  ): UserFollowedEvent {
    return {
      eventId: eventId || crypto.randomUUID(),
      eventType: 'user.followed',
      followerId,
      followeeId,
      actionUrl,
      timestamp: new Date().toISOString(),
      version: 'v1',
    };
  }

  static createCommentCreatedEvent(
    commenterId: string,
    postId: string,
    postOwnerId: string,
    commentText: string,
    actionUrl: string,
    eventId?: string
  ): CommentCreatedEvent {
    return {
      eventId: eventId || crypto.randomUUID(),
      eventType: 'comment.created',
      commenterId,
      postId,
      postOwnerId,
      commentText: commentText.substring(0, 100), // Ensure max 100 chars
      actionUrl,
      timestamp: new Date().toISOString(),
      version: 'v1',
    };
  }

  static createMentionCreatedEvent(
    mentionerId: string,
    mentionedUserId: string,
    contextType: 'comment' | 'post',
    contextId: string,
    mentionText: string,
    actionUrl: string,
    eventId?: string
  ): MentionCreatedEvent {
    return {
      eventId: eventId || crypto.randomUUID(),
      eventType: 'mention.created',
      mentionerId,
      mentionedUserId,
      contextType,
      contextId,
      mentionText,
      actionUrl,
      timestamp: new Date().toISOString(),
      version: 'v1',
    };
  }

  static createLikeCreatedEvent(
    likerId: string,
    targetOwnerId: string,
    targetType: 'post' | 'comment',
    targetId: string,
    actionUrl: string,
    eventId?: string
  ): LikeCreatedEvent {
    return {
      eventId: eventId || crypto.randomUUID(),
      eventType: 'like.created',
      likerId,
      targetOwnerId,
      targetType,
      targetId,
      actionUrl,
      timestamp: new Date().toISOString(),
      version: 'v1',
    };
  }
}

// Backward compatibility rules
export const COMPATIBILITY_RULES = {
  // Rules for schema evolution
  ALLOWED_CHANGES: [
    'ADD_OPTIONAL_FIELD',    // Can add new optional fields
    'ADD_ENUM_VALUE',        // Can add new enum values
    'INCREASE_STRING_LENGTH', // Can increase max length constraints
    'ADD_NEW_EVENT_TYPE',    // Can add new event types
  ],
  
  FORBIDDEN_CHANGES: [
    'REMOVE_FIELD',          // Cannot remove existing fields
    'CHANGE_FIELD_TYPE',     // Cannot change field data types
    'MAKE_FIELD_REQUIRED',   // Cannot make optional fields required
    'REMOVE_ENUM_VALUE',     // Cannot remove existing enum values
    'DECREASE_STRING_LENGTH', // Cannot decrease max length
    'RENAME_FIELD',          // Cannot rename fields
  ],
  
  VERSION_MIGRATION: {
    // Define how to migrate between versions
    'v1_to_v2': {
      // Future migration logic would go here
      // Example: add default values for new fields
    }
  }
};

// Event metadata for tracking and debugging
export interface EventMetadata {
  eventId: string;
  receivedAt: Date;
  processedAt?: Date;
  source: string;
  retryCount?: number;
  errors?: string[];
}

// Event processing result
export interface EventProcessingResult {
  success: boolean;
  eventId: string;
  notificationId?: string;
  error?: string;
  retryable: boolean;
}

// Export JSON Schema for external systems
export const EVENT_SCHEMAS_JSON = {
  UserFollowedEvent: {
    type: 'object',
    required: ['eventId', 'eventType', 'followerId', 'followeeId', 'actionUrl', 'timestamp', 'version'],
    properties: {
      eventId: { type: 'string', format: 'uuid' },
      eventType: { type: 'string', enum: ['user.followed'] },
      followerId: { type: 'string', minLength: 1 },
      followeeId: { type: 'string', minLength: 1 },
      actionUrl: { type: 'string', format: 'uri' },
      timestamp: { type: 'string', format: 'date-time' },
      version: { type: 'string', enum: ['v1'] },
    },
    additionalProperties: false,
  },
  
  CommentCreatedEvent: {
    type: 'object',
    required: ['eventId', 'eventType', 'commenterId', 'postId', 'postOwnerId', 'commentText', 'actionUrl', 'timestamp', 'version'],
    properties: {
      eventId: { type: 'string', format: 'uuid' },
      eventType: { type: 'string', enum: ['comment.created'] },
      commenterId: { type: 'string', minLength: 1 },
      postId: { type: 'string', minLength: 1 },
      postOwnerId: { type: 'string', minLength: 1 },
      commentText: { type: 'string', maxLength: 100 },
      actionUrl: { type: 'string', format: 'uri' },
      timestamp: { type: 'string', format: 'date-time' },
      version: { type: 'string', enum: ['v1'] },
    },
    additionalProperties: false,
  },
  
  MentionCreatedEvent: {
    type: 'object',
    required: ['eventId', 'eventType', 'mentionerId', 'mentionedUserId', 'contextType', 'contextId', 'mentionText', 'actionUrl', 'timestamp', 'version'],
    properties: {
      eventId: { type: 'string', format: 'uuid' },
      eventType: { type: 'string', enum: ['mention.created'] },
      mentionerId: { type: 'string', minLength: 1 },
      mentionedUserId: { type: 'string', minLength: 1 },
      contextType: { type: 'string', enum: ['comment', 'post'] },
      contextId: { type: 'string', minLength: 1 },
      mentionText: { type: 'string', minLength: 1 },
      actionUrl: { type: 'string', format: 'uri' },
      timestamp: { type: 'string', format: 'date-time' },
      version: { type: 'string', enum: ['v1'] },
    },
    additionalProperties: false,
  },
};