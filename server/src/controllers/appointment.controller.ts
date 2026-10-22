import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { AppointmentSlot, type AppointmentSlotStatus, type IAppointmentSlot } from '../models/AppointmentSlot';
import { User } from '../models/User';
import type { AuthenticatedRequest } from '../types/auth.types';
import type { SafeUser } from '../types/user.types';
import { createAuditLog, getRequestIpAddress } from '../utils/audit.util';
import { asyncHandler } from '../utils/asyncHandler.util';

/**
 * Appointment slots (docs/API_APPOINTMENTS.md). Deliberately minimal: a verified doctor publishes a time, any patient
 * books it, either side can withdraw. Every state change is one status-guarded write, so concurrent bookings of one
 * slot produce exactly one booking, and only the slot's doctor (or the booking patient) can change it.
 */

export const SLOT_MIN_MINUTES = 10;
export const SLOT_MAX_MINUTES = 120;
export const SLOT_MAX_DAYS_AHEAD = 90;
const LIST_LIMIT = 200;

/** Wire shape. People are `{ id, name }` (a doctor adds `organisation`): never an email or account details. */
export interface AppointmentSlotResponse {
  id: string;
  doctor: { id: string; name: string; organisation?: string };
  startsAt: string;
  endsAt: string;
  status: AppointmentSlotStatus;
  /** To the slot's doctor once booked, and to the patient who booked it. Never to anyone else. */
  patient?: { id: string; name: string };
  bookedAt?: string;
  cancelledAt?: string;
}

interface PopulatedPerson {
  _id: Types.ObjectId;
  name: string;
  organisation?: string;
}

const isPopulatedPerson = (value: unknown): value is PopulatedPerson =>
  typeof value === 'object' && value !== null && '_id' in value && 'name' in value;

const personRef = (value: unknown, fallbackId: Types.ObjectId | undefined, fallbackName: string) =>
  isPopulatedPerson(value) ? { id: value._id.toString(), name: value.name } : { id: fallbackId?.toString() ?? '', name: fallbackName };

/** The id behind a reference, whether or not it has been populated. */
const idOf = (value: unknown): string => (isPopulatedPerson(value) ? value._id.toString() : String(value));

const serializeSlot = (slot: IAppointmentSlot, includePatient: boolean): AppointmentSlotResponse => {
  const doctor = slot.doctorId as unknown;
  const patient = slot.patientId as unknown;

  return {
    id: slot._id.toString(),
    doctor: {
      ...personRef(doctor, slot.doctorId, 'Unknown doctor'),
      ...(isPopulatedPerson(doctor) && doctor.organisation ? { organisation: doctor.organisation } : {}),
    },
    startsAt: slot.startsAt.toISOString(),
    endsAt: slot.endsAt.toISOString(),
    status: slot.status,
    ...(includePatient && slot.patientId ? { patient: personRef(patient, slot.patientId, 'Unknown patient') } : {}),
    ...(slot.bookedAt ? { bookedAt: slot.bookedAt.toISOString() } : {}),
    ...(slot.cancelledAt ? { cancelledAt: slot.cancelledAt.toISOString() } : {}),
  };
};

const POPULATE = [
  { path: 'doctorId', select: 'name organisation' },
  { path: 'patientId', select: 'name' },
];

const loadSlot = (slotId: Types.ObjectId) => AppointmentSlot.findById(slotId).populate(POPULATE);

const getUser = (req: Parameters<RequestHandler>[0]): SafeUser | undefined => (req as AuthenticatedRequest).user;

const getSlotId = (value: string | string[] | undefined): Types.ObjectId | null => {
  const id = Array.isArray(value) ? value[0] ?? '' : value ?? '';
  return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
};

const audit = (
  req: Parameters<RequestHandler>[0],
  userId: string,
  action: 'APPOINTMENT_SLOT_PUBLISHED' | 'APPOINTMENT_SLOT_CANCELLED' | 'APPOINTMENT_BOOKED' | 'APPOINTMENT_BOOKING_CANCELLED',
  slot: IAppointmentSlot,
  extra: Record<string, string> = {}
) =>
  createAuditLog({
    userId,
    action,
    ipAddress: getRequestIpAddress(req),
    metadata: {
      slotId: slot._id.toString(),
      doctorId: idOf(slot.doctorId),
      startsAt: slot.startsAt.toISOString(),
      ...extra,
    },
  });

/** POST /api/appointments/slots { startsAt, durationMinutes }   (verified doctor) */
export const publishSlot: RequestHandler = asyncHandler(async (req, res) => {
  const doctor = getUser(req);
  if (!doctor) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const startsAt = typeof body.startsAt === 'string' ? new Date(body.startsAt) : new Date(Number.NaN);
  const durationMinutes = body.durationMinutes;

  if (Number.isNaN(startsAt.getTime())) {
    res.status(400).json({ message: 'startsAt must be an ISO 8601 date and time' });
    return;
  }
  if (typeof durationMinutes !== 'number' || !Number.isInteger(durationMinutes) || durationMinutes < SLOT_MIN_MINUTES || durationMinutes > SLOT_MAX_MINUTES) {
    res.status(400).json({ message: `durationMinutes must be a whole number from ${SLOT_MIN_MINUTES} to ${SLOT_MAX_MINUTES}` });
    return;
  }

  const now = Date.now();
  if (startsAt.getTime() <= now || startsAt.getTime() > now + SLOT_MAX_DAYS_AHEAD * 86_400_000) {
    res.status(400).json({ message: `A slot must start in the future and within ${SLOT_MAX_DAYS_AHEAD} days` });
    return;
  }

  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
  const overlapping = await AppointmentSlot.exists({
    doctorId: doctor.id,
    status: { $in: ['OPEN', 'BOOKED'] },
    startsAt: { $lt: endsAt },
    endsAt: { $gt: startsAt },
  });

  if (overlapping) {
    res.status(409).json({ message: 'This slot overlaps another of your slots' });
    return;
  }

  let slot: IAppointmentSlot;
  try {
    slot = await AppointmentSlot.create({ doctorId: doctor.id, startsAt, endsAt, status: 'OPEN' });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      res.status(409).json({ message: 'This slot overlaps another of your slots' });
      return;
    }
    throw error;
  }

  await audit(req, doctor.id, 'APPOINTMENT_SLOT_PUBLISHED', slot, { endsAt: endsAt.toISOString() });
  res.status(201).json({ message: 'Slot published', slot: serializeSlot((await loadSlot(slot._id))!, true) });
});

/** GET /api/appointments/slots   (doctor): the caller's own slots, every status, soonest first. */
export const listMySlots: RequestHandler = asyncHandler(async (req, res) => {
  const doctor = getUser(req);
  if (!doctor) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const slots = await AppointmentSlot.find({ doctorId: doctor.id }).sort({ startsAt: 1 }).limit(LIST_LIMIT).populate(POPULATE);
  res.json({ slots: slots.map((slot) => serializeSlot(slot, true)) });
});

/** DELETE /api/appointments/slots/:id   (doctor, owner): OPEN or BOOKED -> CANCELLED. */
export const cancelSlot: RequestHandler = asyncHandler(async (req, res) => {
  const doctor = getUser(req);
  if (!doctor) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const slotId = getSlotId(req.params.id);
  if (!slotId) {
    res.status(400).json({ message: 'A valid slot ID is required' });
    return;
  }

  const slot = await AppointmentSlot.findById(slotId);
  if (!slot) {
    res.status(404).json({ message: 'Slot not found' });
    return;
  }
  if (!slot.doctorId.equals(doctor.id)) {
    res.status(403).json({ message: 'You can only cancel your own slots' });
    return;
  }

  const result = await AppointmentSlot.updateOne(
    { _id: slotId, doctorId: doctor.id, status: { $in: ['OPEN', 'BOOKED'] } },
    { $set: { status: 'CANCELLED', cancelledAt: new Date() } }
  );
  if (result.modifiedCount !== 1) {
    res.status(409).json({ message: 'This slot is already cancelled' });
    return;
  }

  const cancelled = (await loadSlot(slotId))!;
  await audit(req, doctor.id, 'APPOINTMENT_SLOT_CANCELLED', cancelled, cancelled.patientId ? { patientId: idOf(cancelled.patientId) } : {});
  res.json({ message: 'Slot cancelled', slot: serializeSlot(cancelled, true) });
});

/** GET /api/appointments/available   (patient): open, future slots of verified doctors, soonest first. */
export const listAvailableSlots: RequestHandler = asyncHandler(async (_req, res) => {
  const verifiedDoctorIds = (await User.find({ role: 'doctor', verified: true }).select('_id').lean()).map((doctor) => doctor._id);
  const slots = await AppointmentSlot.find({ status: 'OPEN', startsAt: { $gt: new Date() }, doctorId: { $in: verifiedDoctorIds } })
    .sort({ startsAt: 1 })
    .limit(LIST_LIMIT)
    .populate(POPULATE);
  res.json({ slots: slots.map((slot) => serializeSlot(slot, false)) });
});

/** GET /api/appointments/my   (patient): the caller's current bookings, soonest first. */
export const listMyBookings: RequestHandler = asyncHandler(async (req, res) => {
  const patient = getUser(req);
  if (!patient) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const slots = await AppointmentSlot.find({ patientId: patient.id, status: 'BOOKED' }).sort({ startsAt: 1 }).limit(LIST_LIMIT).populate(POPULATE);
  res.json({ slots: slots.map((slot) => serializeSlot(slot, true)) });
});

/** PATCH /api/appointments/slots/:id/book   (patient): OPEN (future, verified doctor) -> BOOKED by the caller. */
export const bookSlot: RequestHandler = asyncHandler(async (req, res) => {
  const patient = getUser(req);
  if (!patient) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const slotId = getSlotId(req.params.id);
  if (!slotId) {
    res.status(400).json({ message: 'A valid slot ID is required' });
    return;
  }

  const slot = await AppointmentSlot.findById(slotId);
  if (!slot) {
    res.status(404).json({ message: 'Slot not found' });
    return;
  }
  if (!(await User.exists({ _id: slot.doctorId, role: 'doctor', verified: true }))) {
    res.status(409).json({ message: 'This slot is no longer available' });
    return;
  }

  const result = await AppointmentSlot.updateOne(
    { _id: slotId, status: 'OPEN', startsAt: { $gt: new Date() } },
    { $set: { status: 'BOOKED', patientId: new Types.ObjectId(patient.id), bookedAt: new Date() } }
  );
  if (result.modifiedCount !== 1) {
    res.status(409).json({ message: 'This slot is no longer available' });
    return;
  }

  const booked = (await loadSlot(slotId))!;
  await audit(req, patient.id, 'APPOINTMENT_BOOKED', booked, { patientId: patient.id });
  res.json({ message: 'Appointment booked', slot: serializeSlot(booked, true) });
});

/** PATCH /api/appointments/slots/:id/cancel-booking   (patient who booked it): BOOKED -> OPEN. */
export const cancelBooking: RequestHandler = asyncHandler(async (req, res) => {
  const patient = getUser(req);
  if (!patient) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const slotId = getSlotId(req.params.id);
  if (!slotId) {
    res.status(400).json({ message: 'A valid slot ID is required' });
    return;
  }

  const slot = await AppointmentSlot.findById(slotId);
  if (!slot) {
    res.status(404).json({ message: 'Slot not found' });
    return;
  }
  if (!slot.patientId?.equals(patient.id)) {
    res.status(403).json({ message: 'You can only cancel your own booking' });
    return;
  }

  const result = await AppointmentSlot.updateOne(
    { _id: slotId, status: 'BOOKED', patientId: patient.id },
    { $set: { status: 'OPEN' }, $unset: { patientId: '', bookedAt: '' } }
  );
  if (result.modifiedCount !== 1) {
    res.status(409).json({ message: 'This booking is no longer active' });
    return;
  }

  const reopened = (await loadSlot(slotId))!;
  await audit(req, patient.id, 'APPOINTMENT_BOOKING_CANCELLED', reopened, { patientId: patient.id });
  // The slot is OPEN again and no longer the caller's: no patient on the response.
  res.json({ message: 'Booking cancelled', slot: serializeSlot(reopened, false) });
});
