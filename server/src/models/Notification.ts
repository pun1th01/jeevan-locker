import mongoose, { Document, Schema, Types } from 'mongoose';
import { APP_EVENT_NAMES, type AppEventName } from '../events/appEvents';

export interface INotification extends Document {
  _id: Types.ObjectId;
  recipientUserId: Types.ObjectId;
  actorUserId: Types.ObjectId;
  actorName: string;
  eventName: AppEventName;
  message: string;
  documentId: Types.ObjectId | null;
  dedupeKey: string;
  read: boolean;
  createdAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    recipientUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actorName: { type: String, required: true, trim: true },
    eventName: { type: String, enum: APP_EVENT_NAMES, required: true, index: true },
    message: { type: String, required: true, trim: true },
    documentId: { type: Schema.Types.ObjectId, ref: 'MedicalDocument', default: null },
    dedupeKey: { type: String, required: true, trim: true },
    read: { type: Boolean, required: true, default: false, index: true },
    createdAt: { type: Date, required: true, default: Date.now, index: true },
  },
  { versionKey: false }
);

// Dedupe applies to the intended recipient, not globally: the same event can legitimately notify two users.
notificationSchema.index({ recipientUserId: 1, dedupeKey: 1 }, { unique: true });
notificationSchema.index({ recipientUserId: 1, read: 1, createdAt: -1 });

export const Notification = mongoose.model<INotification>('Notification', notificationSchema);
