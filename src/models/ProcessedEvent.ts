import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IProcessedEvent extends Document {
  eventId: string;
  userId: string;
  eventType: string;
  processedAt: Date;
}

const ProcessedEventSchema = new Schema<IProcessedEvent>({
  eventId: { type: String, required: true },
  userId: { type: String, required: true },
  eventType: { type: String, required: true },
  processedAt: { type: Date, required: true, default: Date.now },
}, {
  collection: 'processed_events',
});

ProcessedEventSchema.index({ eventId: 1, userId: 1 }, { unique: true });

const ProcessedEvent: Model<IProcessedEvent> = mongoose.model<IProcessedEvent>('ProcessedEvent', ProcessedEventSchema);

export default ProcessedEvent;
