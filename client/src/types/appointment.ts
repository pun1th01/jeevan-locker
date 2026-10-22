// Mirrors AppointmentSlotResponse in server/src/controllers/appointment.controller.ts and docs/API_APPOINTMENTS.md.

export type AppointmentSlotStatus = 'OPEN' | 'BOOKED' | 'CANCELLED';

export interface AppointmentSlot {
  id: string;
  doctor: { id: string; name: string; organisation?: string };
  startsAt: string;
  endsAt: string;
  status: AppointmentSlotStatus;
  /** Present to the doctor who owns the slot once it is booked, and to the patient who booked it. */
  patient?: { id: string; name: string };
  bookedAt?: string;
  cancelledAt?: string;
}

export interface PublishSlotInput {
  /** ISO 8601 */
  startsAt: string;
  durationMinutes: number;
}
