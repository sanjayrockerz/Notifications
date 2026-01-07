import mongoose, { Schema, Document, Model } from 'mongoose';

// Add custom statics and methods to UserPreferences model
export interface IUserPreferences extends Document {
  userId: string;
  notificationTypes?: Record<string, { isEnabled: boolean }>;
  quietHours?: {
    enabled: boolean;
    start: string;
    end: string;
    timezone: string;
  };
  globalSettings: {
    enabled: boolean;
    quietHours: {
      enabled: boolean;
      startTime: string;
      endTime: string;
      timezone: string;
    };
    frequency: 'immediate' | 'batched' | 'daily_digest';
    batchInterval: number;
  };
  categories: Record<string, {
    enabled: boolean;
    priority: 'low' | 'normal' | 'high' | 'critical';
    delivery: {
      push: boolean;
      email?: boolean;
      sms?: boolean;
    };
    sound: string;
    vibration: boolean;
  }>;
  platforms: {
    [platform: string]: {
      enabled: boolean;
      sound: boolean;
      alert: boolean;
      criticalAlerts: boolean;
    };
  };
  content: {
    language: string;
    personalization: boolean;
    marketing: boolean;
    promotional: boolean;
  };
  advanced: {
    groupSimilar: boolean;
    smartDelivery: boolean;
    adaptivePriority: boolean;
    maxDailyNotifications: number;
  };
  blocked: {
    keywords: string[];
    sources: string[];
    senders: string[];
  };
  lastUpdated: Date;
  version: number;
  migrationFlags: Record<string, boolean>;
  
  // Instance methods
  isQuietTime(date?: Date): boolean;
  shouldDeliverNotification(
    category: string,
    priority: string,
    source: string,
    content: { title: string; body: string }
  ): { shouldDeliver: boolean; reason?: string };
}

export interface UserPreferencesModel extends Model<IUserPreferences> {
  findOrCreate(userId: string): Promise<IUserPreferences>;
}

const UserPreferencesSchema = new Schema<IUserPreferences>({
  userId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  
  // Simplified notification type preferences (for Task 4.4)
  notificationTypes: {
    type: Schema.Types.Mixed,
    default: {
      follow: { isEnabled: true },
      like: { isEnabled: true },
      comment: { isEnabled: true },
      mention: { isEnabled: true },
      message: { isEnabled: true },
    },
  },
  
  // Simplified quiet hours (for Task 4.5)
  quietHours: {
    enabled: { type: Boolean, default: false },
    start: { type: String, default: '22:00' },
    end: { type: String, default: '09:00' },
    timezone: { type: String, default: 'UTC' },
  },
  
  globalSettings: {
    enabled: { type: Boolean, default: true },
    quietHours: {
      enabled: { type: Boolean, default: false },
      startTime: { type: String, default: '22:00' },
      endTime: { type: String, default: '08:00' },
      timezone: { type: String, default: 'UTC' },
    },
    frequency: {
      type: String,
      enum: ['immediate', 'batched', 'daily_digest'],
      default: 'immediate',
    },
    batchInterval: { type: Number, default: 15 }, // minutes
  },
  
  categories: {
    type: Schema.Types.Mixed,
    default: {
      // Default categories
      'general': {
        enabled: true,
        priority: 'normal',
        delivery: { push: true },
        sound: 'default',
        vibration: true,
      },
      'chat': {
        enabled: true,
        priority: 'high',
        delivery: { push: true },
        sound: 'message',
        vibration: true,
      },
      'order': {
        enabled: true,
        priority: 'high',
        delivery: { push: true },
        sound: 'default',
        vibration: true,
      },
      'promotion': {
        enabled: false,
        priority: 'low',
        delivery: { push: true },
        sound: 'subtle',
        vibration: false,
      },
    },
  },
  
  platforms: {
    android: {
      enabled: { type: Boolean, default: true },
      channels: {
        type: Schema.Types.Mixed,
        default: {
          'default': {
            enabled: true,
            importance: 'default',
            sound: 'default',
            vibration: true,
            lights: true,
          },
          'messages': {
            enabled: true,
            importance: 'high',
            sound: 'message_tone',
            vibration: true,
            lights: true,
          },
        },
      },
    },
    ios: {
      enabled: { type: Boolean, default: true },
      badge: { type: Boolean, default: true },
      sound: { type: Boolean, default: true },
      alert: { type: Boolean, default: true },
      criticalAlerts: { type: Boolean, default: false },
    },
  },
  
  content: {
    language: { type: String, default: 'en' },
    personalization: { type: Boolean, default: true },
    marketing: { type: Boolean, default: false },
    promotional: { type: Boolean, default: false },
  },
  
  advanced: {
    groupSimilar: { type: Boolean, default: true },
    smartDelivery: { type: Boolean, default: true },
    adaptivePriority: { type: Boolean, default: true },
    maxDailyNotifications: { type: Number, default: 100 },
  },
  
  blocked: {
    keywords: [{ type: String }],
    sources: [{ type: String }],
    senders: [{ type: String }],
  },
  
  lastUpdated: {
    type: Date,
    default: Date.now,
  },
  version: {
    type: Number,
    default: 1,
  },
  migrationFlags: {
    type: Schema.Types.Mixed,
    default: {},
  },
}, {
  timestamps: true,
  collection: 'user_preferences',
});

// Indexes
UserPreferencesSchema.index({ lastUpdated: -1 });
UserPreferencesSchema.index({ version: 1 });

// Methods
UserPreferencesSchema.methods.updateCategory = function(
  categoryName: string,
  settings: Partial<IUserPreferences['categories'][string]>
): Promise<IUserPreferences> {
  if (!this.categories[categoryName]) {
    this.categories[categoryName] = {
      enabled: true,
      priority: 'normal',
      delivery: { push: true },
      sound: 'default',
      vibration: true,
    };
  }
  
  Object.assign(this.categories[categoryName], settings);
  this.lastUpdated = new Date();
  this.markModified('categories');
  
  return this.save();
};

UserPreferencesSchema.methods.blockKeyword = function(keyword: string): Promise<IUserPreferences> {
  if (!this.blocked.keywords.includes(keyword)) {
    this.blocked.keywords.push(keyword);
    this.lastUpdated = new Date();
  }
  return this.save();
};

UserPreferencesSchema.methods.blockSource = function(source: string): Promise<IUserPreferences> {
  if (!this.blocked.sources.includes(source)) {
    this.blocked.sources.push(source);
    this.lastUpdated = new Date();
  }
  return this.save();
};

UserPreferencesSchema.methods.isQuietTime = function(date?: Date): boolean {
  if (!this.globalSettings.quietHours.enabled) {
    return false;
  }
  
  const now = date || new Date();
  const currentTime = now.toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: this.globalSettings.quietHours.timezone,
    hour: '2-digit',
    minute: '2-digit',
  });
  
  const startTime = this.globalSettings.quietHours.startTime;
  const endTime = this.globalSettings.quietHours.endTime;
  
  // Handle overnight quiet hours (e.g., 22:00 to 08:00)
  if (startTime > endTime) {
    return currentTime >= startTime || currentTime <= endTime;
  }
  
  return currentTime >= startTime && currentTime <= endTime;
};

UserPreferencesSchema.methods.shouldDeliverNotification = function(
  category: string,
  priority: string,
  source: string,
  content: { title: string; body: string }
): { shouldDeliver: boolean; reason?: string } {
  // Check global settings
  if (!this.globalSettings.enabled) {
    return { shouldDeliver: false, reason: 'notifications_disabled' };
  }
  
  // Check quiet hours
  if (this.isQuietTime() && priority !== 'critical') {
    return { shouldDeliver: false, reason: 'quiet_hours' };
  }
  
  // Check blocked sources
  if (this.blocked.sources.includes(source)) {
    return { shouldDeliver: false, reason: 'source_blocked' };
  }
  
  // Check blocked keywords
  const fullText = `${content.title} ${content.body}`.toLowerCase();
  const hasBlockedKeyword = this.blocked.keywords.some((keyword: any) => 
    fullText.includes(keyword.toLowerCase())
  );
  
  if (hasBlockedKeyword) {
    return { shouldDeliver: false, reason: 'keyword_blocked' };
  }
  
  // Check category settings
  const categorySettings = this.categories[category];
  if (categorySettings && !categorySettings.enabled) {
    return { shouldDeliver: false, reason: 'category_disabled' };
  }
  
  return { shouldDeliver: true };
};

// Static methods
UserPreferencesSchema.statics.findOrCreate = async function(userId: string): Promise<IUserPreferences> {
  let preferences = await this.findOne({ userId });
  
  if (!preferences) {
    preferences = new this({ userId });
    await preferences.save();
  }
  
  return preferences;
};

UserPreferencesSchema.statics.migratePreferences = function(version: number): Promise<any> {
  return this.updateMany(
    { version: { $lt: version } },
    { 
      $set: { version },
      $currentDate: { lastUpdated: true },
    }
  );
};

const UserPreferences = mongoose.model<IUserPreferences, UserPreferencesModel>('UserPreferences', UserPreferencesSchema);

export default UserPreferences;