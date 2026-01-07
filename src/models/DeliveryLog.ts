import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IDeliveryLog extends Document {
  notificationId: string;
  deviceId: string;
  status: 'pending' | 'sent' | 'failed' | 'invalid_token';
  attemptCount: number;
  lastError?: string;
  nextRetryAt?: Date;
  sentAt?: Date;
  createdAt: Date;
}

const DeliveryLogSchema = new Schema<IDeliveryLog>({
  notificationId: { type: String, required: true, index: true },
  deviceId: { type: String, required: true, index: true },
  status: { type: String, enum: ['pending', 'sent', 'failed', 'invalid_token'], required: true, default: 'pending', index: true },
  attemptCount: { type: Number, default: 0 },
  lastError: String,
  nextRetryAt: Date,
  sentAt: Date,
  createdAt: { type: Date, default: Date.now },
}, {
  collection: 'delivery_log',
});

DeliveryLogSchema.index({ notificationId: 1, deviceId: 1 }, { unique: true });

const DeliveryLog: Model<IDeliveryLog> = mongoose.model<IDeliveryLog>('DeliveryLog', DeliveryLogSchema);

export default DeliveryLog;
