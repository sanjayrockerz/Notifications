import mongoose, { Schema, Document, Model } from 'mongoose';

// Add custom statics and methods to Device model
export interface IDevice extends Document {
  userId: string;
  deviceToken: string;
  platform: 'android' | 'ios';
  fcmToken: string;
  appVersion: string;
  deviceInfo: {
    model: string;
    osVersion: string;
    manufacturer?: string;
    screenSize?: string;
    locale?: string;
    timezone?: string;
  };
  isActive: boolean;
  lastSeen: Date;
  registrationDate: Date;
  pushSettings: {
    enabled: boolean;
    sound: boolean;
    badge: boolean;
    alert: boolean;
  };
  failureCount: number;
  lastFailure?: Date;
  tags: string[];
  metadata: Record<string, any>;
  markAsSeen(): Promise<IDevice>;
  incrementFailureCount(): Promise<IDevice>;
}

export interface DeviceModel extends Model<IDevice> {
  findActiveByUser(userId: string): Promise<IDevice[]>;
  findByPlatform(platform: 'android' | 'ios', isActive?: boolean): Promise<IDevice[]>;
  cleanupInactive(daysInactive?: number): Promise<any>;
}

const DeviceSchema = new Schema<IDevice>({
  userId: {
    type: String,
    required: true,
    index: true,
  },
  deviceToken: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  platform: {
    type: String,
    enum: ['android', 'ios'],
    required: true,
  },
  fcmToken: {
    type: String,
    required: false,
    index: true,
  },
  appVersion: {
    type: String,
    required: true,
  },
  deviceInfo: {
    model: { type: String, required: true },
    osVersion: { type: String, required: true },
    manufacturer: String,
    screenSize: String,
    locale: String,
    timezone: String,
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true,
  },
  lastSeen: {
    type: Date,
    default: Date.now,
    index: true,
  },
  registrationDate: {
    type: Date,
    default: Date.now,
  },
  pushSettings: {
    enabled: { type: Boolean, default: true },
    sound: { type: Boolean, default: true },
    badge: { type: Boolean, default: true },
    alert: { type: Boolean, default: true },
  },
  failureCount: {
    type: Number,
    default: 0,
  },
  lastFailure: Date,
  tags: [{
    type: String,
  }],
  metadata: {
    type: Schema.Types.Mixed,
    default: {},
  },
}, {
  timestamps: true,
  collection: 'devices',
});

// Indexes
DeviceSchema.index({ userId: 1, platform: 1 });
DeviceSchema.index({ userId: 1, isActive: 1 });
DeviceSchema.index({ lastSeen: 1 });
DeviceSchema.index({ createdAt: 1 });

// Methods
DeviceSchema.methods.markAsSeen = function(): Promise<IDevice> {
  this.lastSeen = new Date();
  this.failureCount = 0;
  return this.save();
};

DeviceSchema.methods.incrementFailureCount = function(): Promise<IDevice> {
  this.failureCount += 1;
  this.lastFailure = new Date();
  
  // Deactivate device after 5 consecutive failures
  if (this.failureCount >= 5) {
    this.isActive = false;
  }
  
  return this.save();
};

DeviceSchema.methods.updatePushSettings = function(settings: Partial<IDevice['pushSettings']>): Promise<IDevice> {
  Object.assign(this.pushSettings, settings);
  return this.save();
};

// Static methods
DeviceSchema.statics.findActiveByUser = function(userId: string): Promise<IDevice[]> {
  return this.find({ userId, isActive: true }).sort({ lastSeen: -1 });
};

DeviceSchema.statics.findByPlatform = function(platform: 'android' | 'ios', isActive = true): Promise<IDevice[]> {
  return this.find({ platform, isActive }).sort({ lastSeen: -1 });
};

DeviceSchema.statics.cleanupInactive = function(daysInactive = 30): Promise<any> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysInactive);
  
  return this.deleteMany({
    $or: [
      { lastSeen: { $lt: cutoffDate } },
      { isActive: false, lastFailure: { $lt: cutoffDate } },
    ],
  });
};

const Device = mongoose.model<IDevice, DeviceModel>('Device', DeviceSchema);

export default Device;