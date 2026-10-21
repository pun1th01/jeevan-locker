import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * A time a doctor publishes for patients to book (docs/API_APPOINTMENTS.md).
 *   OPEN      -> BOOKED     (a patient books it)
 *   BOOKED    -> OPEN       (that patient cancels their booking; the time is free again)
 *   OPEN      -> CANCELLED  (the doctor withdraws it)
 *   BOOKED    -> CANCELLED  (the doctor withdraws it; the booking ends with it)
 * CANCELLED is terminal. Every transition is a single status-guarded write, so two patients can never hold one slot.
 */
export const APPOINTMENT_SLOT_STATUSES = ['OPEN', 'BOOKED', 'CANCELLED'] as const;
export type AppointmentSlotStatus = (typeof APPOINTMENT_SLOT_STATUSES)[number];

export interface IAppointmentSlot extends Document {
  _id: Types.ObjectId;
  doctorId: Types.ObjectId;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentSlotStatus;
  /** Set while BOOKED, cleared when the patient cancels the booking. */
  patientId?: Types.ObjectId;
  bookedAt?: Date;
  cancelledAt?: Date;
  createdAt: Date;
}

const appointmentSlotSchema = new Schema<IAppointmentSlot>(
  {
    doctorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    status: { type: String, enum: APPOINTMENT_SLOT_STATUSES, default: 'OPEN', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'User', default: undefined, index: true },
    bookedAt: { type: Date, default: undefined },
    cancelledAt: { type: Date, default: undefined },
    createdAt: { type: Date, default: Date.now, required: true },
  },
  { versionKey: false }
);

// One live slot per doctor per start time, whatever the server process. Overlaps are checked by the handler.
appointmentSlotSchema.index(
  { doctorId: 1, startsAt: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['OPEN', 'BOOKED'] } }, name: 'one_live_slot_per_doctor_start' }
);
// The patients' "available" list: open slots, soonest first.
appointmentSlotSchema.index({ status: 1, startsAt: 1 });

export const AppointmentSlot = mongoose.model<IAppointmentSlot>('AppointmentSlot', appointmentSlotSchema);
