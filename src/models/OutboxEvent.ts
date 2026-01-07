import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IOutboxEvent extends Document {
  outboxId: string;
  eventId: string;
  eventType: string;
  payload: Record<string, any>;
  published: boolean;
  createdAt: Date;
  publishedAt?: Date;
  retryCount: number;
  lastError?: string;
}

export interface OutboxEventModel extends Model<IOutboxEvent> {
  findUnpublished(limit?: number): Promise<IOutboxEvent[]>;
  markAsPublished(outboxId: string): Promise<IOutboxEvent | null>;
  incrementRetryCount(outboxId: string, error: string): Promise<IOutboxEvent | null>;
}

const OutboxEventSchema = new Schema<IOutboxEvent>({
  outboxId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  eventId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  eventType: {
    type: String,
    required: true,
    index: true,
  },
  payload: {
    type: Schema.Types.Mixed,
    required: true,
  },
  published: {
    type: Boolean,
    default: false,
    index: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  publishedAt: {
    type: Date,
    index: true,
  },
  retryCount: {
    type: Number,
    default: 0,
  },
  lastError: String,
}, {
  timestamps: false,
  collection: 'outbox_events',
});

// Compound index for efficient querying of unpublished events
OutboxEventSchema.index({ published: 1, createdAt: 1 });

// Static methods
OutboxEventSchema.statics.findUnpublished = function(limit = 100): Promise<IOutboxEvent[]> {
  return this.find({ published: false })
    .sort({ createdAt: 1 })
    .limit(limit);
};

OutboxEventSchema.statics.markAsPublished = function(outboxId: string): Promise<IOutboxEvent | null> {
  return this.findOneAndUpdate(
    { outboxId },
    {
      $set: {
        published: true,
        publishedAt: new Date(),
      },
    },
    { new: true }
  );
};

OutboxEventSchema.statics.incrementRetryCount = function(
  outboxId: string,
  error: string
): Promise<IOutboxEvent | null> {
  return this.findOneAndUpdate(
    { outboxId },
    {
      $inc: { retryCount: 1 },
      $set: { lastError: error },
    },
    { new: true }
  );
};

const OutboxEvent = mongoose.model<IOutboxEvent, OutboxEventModel>('OutboxEvent', OutboxEventSchema);

export default OutboxEvent;
