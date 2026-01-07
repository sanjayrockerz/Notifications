import Joi from 'joi';
import { Request, Response, NextFunction } from 'express';
import { logger } from './logger';

// Common validation schemas
export const commonSchemas = {
  objectId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).message('Invalid ObjectId format'),
  uuid: Joi.string().uuid().message('Invalid UUID format'),
  userId: Joi.string().min(1).max(100).required(),
  deviceToken: Joi.string().min(10).max(500).required(),
  notificationId: Joi.string().uuid().required(),
  pagination: {
    limit: Joi.number().integer().min(1).max(100).default(20),
    skip: Joi.number().integer().min(0).default(0),
    page: Joi.number().integer().min(1).default(1),
  },
};

// Device registration schema
export const deviceRegistrationSchema = Joi.object({
  userId: commonSchemas.userId,
  deviceToken: commonSchemas.deviceToken,
  platform: Joi.string().valid('android', 'ios').required(),
  appVersion: Joi.string().required(),
  deviceInfo: Joi.object({
    model: Joi.string().required(),
    osVersion: Joi.string().required(),
    manufacturer: Joi.string().optional(),
    screenSize: Joi.string().optional(),
    locale: Joi.string().optional(),
    timezone: Joi.string().optional(),
  }).required(),
  pushSettings: Joi.object({
    enabled: Joi.boolean().default(true),
    sound: Joi.boolean().default(true),
    badge: Joi.boolean().default(true),
    alert: Joi.boolean().default(true),
  }).optional(),
  tags: Joi.array().items(Joi.string()).optional(),
  metadata: Joi.object().optional(),
});

// Device update schema
export const deviceUpdateSchema = Joi.object({
  deviceToken: commonSchemas.deviceToken.optional(),
  appVersion: Joi.string().optional(),
  deviceInfo: Joi.object({
    model: Joi.string().optional(),
    osVersion: Joi.string().optional(),
    manufacturer: Joi.string().optional(),
    screenSize: Joi.string().optional(),
    locale: Joi.string().optional(),
    timezone: Joi.string().optional(),
  }).optional(),
  pushSettings: Joi.object({
    enabled: Joi.boolean().optional(),
    sound: Joi.boolean().optional(),
    badge: Joi.boolean().optional(),
    alert: Joi.boolean().optional(),
  }).optional(),
  tags: Joi.array().items(Joi.string()).optional(),
  metadata: Joi.object().optional(),
  isActive: Joi.boolean().optional(),
});

// Send notification schema
export const sendNotificationSchema = Joi.object({
  userId: commonSchemas.userId,
  title: Joi.string().min(1).max(100).required(),
  body: Joi.string().min(1).max(500).required(),
  category: Joi.string().min(1).max(50).required(),
  priority: Joi.string().valid('low', 'normal', 'high', 'critical').default('normal'),
  data: Joi.object().optional(),
  imageUrl: Joi.string().uri().optional(),
  iconUrl: Joi.string().uri().optional(),
  scheduleAt: Joi.date().greater('now').optional(),
  timezone: Joi.string().optional(),
  tags: Joi.array().items(Joi.string()).optional(),
  source: Joi.string().required(),
  campaign: Joi.string().optional(),
  metadata: Joi.object().optional(),
});

// Schedule notification schema
export const scheduleNotificationSchema = Joi.object({
  userId: commonSchemas.userId,
  title: Joi.string().min(1).max(100).required(),
  body: Joi.string().min(1).max(500).required(),
  category: Joi.string().min(1).max(50).required(),
  priority: Joi.string().valid('low', 'normal', 'high', 'critical').default('normal'),
  data: Joi.object().optional(),
  imageUrl: Joi.string().uri().optional(),
  iconUrl: Joi.string().uri().optional(),
  scheduleAt: Joi.date().greater('now').required(),
  timezone: Joi.string().default('UTC'),
  tags: Joi.array().items(Joi.string()).optional(),
  source: Joi.string().required(),
  campaign: Joi.string().optional(),
  metadata: Joi.object().optional(),
});

// User preferences schema
export const userPreferencesSchema = Joi.object({
  globalSettings: Joi.object({
    enabled: Joi.boolean().default(true),
    quietHours: Joi.object({
      enabled: Joi.boolean().default(false),
      startTime: Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).default('22:00'),
      endTime: Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).default('08:00'),
      timezone: Joi.string().default('UTC'),
    }).optional(),
    frequency: Joi.string().valid('immediate', 'batched', 'daily_digest').default('immediate'),
    batchInterval: Joi.number().integer().min(5).max(120).default(15),
  }).optional(),
  categories: Joi.object().pattern(
    Joi.string(),
    Joi.object({
      enabled: Joi.boolean().default(true),
      priority: Joi.string().valid('low', 'normal', 'high', 'critical').default('normal'),
      delivery: Joi.object({
        push: Joi.boolean().default(true),
        email: Joi.boolean().optional(),
        sms: Joi.boolean().optional(),
      }).optional(),
      sound: Joi.string().default('default'),
      vibration: Joi.boolean().default(true),
    })
  ).optional(),
  content: Joi.object({
    language: Joi.string().length(2).default('en'),
    personalization: Joi.boolean().default(true),
    marketing: Joi.boolean().default(false),
    promotional: Joi.boolean().default(false),
  }).optional(),
  blocked: Joi.object({
    keywords: Joi.array().items(Joi.string()).optional(),
    sources: Joi.array().items(Joi.string()).optional(),
    senders: Joi.array().items(Joi.string()).optional(),
  }).optional(),
});

// Query parameter schemas
export const notificationQuerySchema = Joi.object({
  limit: commonSchemas.pagination.limit,
  skip: commonSchemas.pagination.skip,
  unreadOnly: Joi.boolean().default(false),
  category: Joi.string().optional(),
  priority: Joi.string().valid('low', 'normal', 'high', 'critical').optional(),
  source: Joi.string().optional(),
  fromDate: Joi.date().optional(),
  toDate: Joi.date().optional(),
});

export const deviceQuerySchema = Joi.object({
  platform: Joi.string().valid('android', 'ios').optional(),
  active: Joi.boolean().optional(),
  limit: commonSchemas.pagination.limit,
  skip: commonSchemas.pagination.skip,
});

// Event schemas
export const eventValidationSchemas = {
  userFollowed: Joi.object({
    eventId: commonSchemas.uuid,
    eventType: Joi.string().valid('user.followed').required(),
    followerId: commonSchemas.userId,
    followeeId: commonSchemas.userId,
    actionUrl: Joi.string().uri().required(),
    timestamp: Joi.string().isoDate().required(),
    version: Joi.string().valid('v1').required(),
  }),
  
  commentCreated: Joi.object({
    eventId: commonSchemas.uuid,
    eventType: Joi.string().valid('comment.created').required(),
    commenterId: commonSchemas.userId,
    postId: Joi.string().required(),
    postOwnerId: commonSchemas.userId,
    commentText: Joi.string().max(100).required(),
    actionUrl: Joi.string().uri().required(),
    timestamp: Joi.string().isoDate().required(),
    version: Joi.string().valid('v1').required(),
  }),
  
  mentionCreated: Joi.object({
    eventId: commonSchemas.uuid,
    eventType: Joi.string().valid('mention.created').required(),
    mentionerId: commonSchemas.userId,
    mentionedUserId: commonSchemas.userId,
    contextType: Joi.string().valid('comment', 'post').required(),
    contextId: Joi.string().required(),
    mentionText: Joi.string().required(),
    actionUrl: Joi.string().uri().required(),
    timestamp: Joi.string().isoDate().required(),
    version: Joi.string().valid('v1').required(),
  }),
};

// Validation middleware factory
export function validateRequest(schema: Joi.ObjectSchema, source: 'body' | 'query' | 'params' = 'body') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const data = req[source];
    
    const { error, value } = schema.validate(data, {
      abortEarly: false,
      stripUnknown: true,
      convert: true,
    });
    
    if (error) {
      const validationErrors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message,
        value: detail.context?.value,
      }));
      
      logger.warn('Validation failed', {
        source,
        errors: validationErrors,
        originalData: data,
      });
      
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: validationErrors,
      });
      return;
    }
    
    // Replace the original data with validated and converted data
    req[source] = value;
    next();
  };
}

// Custom validation functions
export const customValidators = {
  isValidTimezone: (timezone: string): boolean => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
      return true;
    } catch {
      return false;
    }
  },
  
  isValidDeviceToken: (token: string, platform: 'android' | 'ios'): boolean => {
    if (platform === 'android') {
      // FCM tokens are typically 152+ characters
      return token.length >= 140 && /^[A-Za-z0-9:_-]+$/.test(token);
    } else if (platform === 'ios') {
      // APNs tokens are 64 hex characters
      return /^[0-9a-fA-F]{64}$/.test(token);
    }
    return false;
  },
  
  isValidQuietHours: (startTime: string, endTime: string): boolean => {
    const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    return timeRegex.test(startTime) && timeRegex.test(endTime);
  },
};

// Sanitization utilities
export const sanitize = {
  html: (text: string): string => {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
  },
  
  deviceToken: (token: string): string => {
    return token.trim().replace(/\s+/g, '');
  },
  
  notificationText: (text: string): string => {
    return text.trim().replace(/\s+/g, ' ');
  },
};

// Validation result helper
export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: Array<{
    field: string;
    message: string;
    value?: any;
  }>;
}

export function validateData<T>(data: any, schema: Joi.ObjectSchema): ValidationResult<T> {
  const { error, value } = schema.validate(data, {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });
  
  if (error) {
    return {
      success: false,
      errors: error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message,
        value: detail.context?.value,
      })),
    };
  }
  
  return {
    success: true,
    data: value,
  };
}