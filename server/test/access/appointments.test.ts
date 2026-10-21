import { beforeAll, describe, expect, it } from 'vitest';
import { UNVERIFIED_DOCTOR_MESSAGE } from '../../src/middleware/auth.middleware';
import { AccessLog, type AuditAction } from '../../src/models/AccessLog';
import { AppointmentSlot } from '../../src/models/AppointmentSlot';
import { User, type IUser } from '../../src/models/User';
import { call, createUser, idOf, tokenFor } from '../support/fixtures';

/**
 * Suite 1h — appointment slots (claim C61 in docs/TESTING.md). Specification: docs/API_APPOINTMENTS.md.
 * Doctors publish, patients book; only a slot's doctor can withdraw it and only the booking patient can cancel the
 * booking; one slot is never booked twice. Every refusal is checked for its side effect, not just its status.
 */

const HOUR = 60 * 60 * 1000;
let hourOffset = 0;
/** A distinct future start for every slot this file publishes, so no two tests can overlap by accident. */
const futureStart = () => new Date(Date.now() + (24 + (hourOffset += 3)) * HOUR).toISOString();

const publish = (doctor: IUser, body: Record<string, unknown>) => call('post', '/api/appointments/slots', tokenFor(doctor)).send(body);

const publishedSlot = async (doctor: IUser, durationMinutes = 30): Promise<string> => {
  const response = await publish(doctor, { startsAt: futureStart(), durationMinutes });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.slot.id as string;
};

const book = (patient: IUser, slotId: string) => call('patch', `/api/appointments/slots/${slotId}/book`, tokenFor(patient));
const statusOf = async (slotId: string) => (await AppointmentSlot.findById(slotId).lean())!.status;
const audits = (action: AuditAction, slotId: string) => AccessLog.countDocuments({ action, 'metadata.slotId': slotId });

let doctor: IUser;
let otherDoctor: IUser;
let patient: IUser;
let otherPatient: IUser;

beforeAll(async () => {
  doctor = await createUser('doctor', { organisation: 'City Heart Clinic' });
  otherDoctor = await createUser('doctor');
  patient = await createUser('patient');
  otherPatient = await createUser('patient');
});

describe('C61 appointment slots: doctors publish, patients book, each side changes only its own, and a slot is booked once', () => {
  it('the full flow: publish, see it as available, book, both sides see the booking, audited at each step', async () => {
    const slotId = await publishedSlot(doctor, 45);
    expect(await audits('APPOINTMENT_SLOT_PUBLISHED', slotId)).toBe(1);

    const available = await call('get', '/api/appointments/available', tokenFor(patient));
    const listed = available.body.slots.find((slot: { id: string }) => slot.id === slotId);
    expect(listed).toMatchObject({ status: 'OPEN', doctor: { id: idOf(doctor), name: doctor.name, organisation: 'City Heart Clinic' } });
    expect(Object.keys(listed.doctor).sort()).toEqual(['id', 'name', 'organisation']);
    expect(listed).not.toHaveProperty('patient');
    expect(new Date(listed.endsAt).getTime() - new Date(listed.startsAt).getTime()).toBe(45 * 60_000);

    const booked = await book(patient, slotId);
    expect(booked.status).toBe(200);
    expect(booked.body.slot).toMatchObject({ status: 'BOOKED', patient: { id: idOf(patient), name: patient.name } });
    expect(await audits('APPOINTMENT_BOOKED', slotId)).toBe(1);

    const doctorView = (await call('get', '/api/appointments/slots', tokenFor(doctor))).body.slots.find((slot: { id: string }) => slot.id === slotId);
    expect(doctorView.patient).toEqual({ id: idOf(patient), name: patient.name });
    const mine = (await call('get', '/api/appointments/my', tokenFor(patient))).body.slots.map((slot: { id: string }) => slot.id);
    expect(mine).toContain(slotId);

    // Booked slots leave the available list; no email anywhere in what either side receives.
    const after = await call('get', '/api/appointments/available', tokenFor(otherPatient));
    expect(after.body.slots.map((slot: { id: string }) => slot.id)).not.toContain(slotId);
    for (const payload of [available.body, booked.body, after.body]) expect(JSON.stringify(payload)).not.toMatch(/@test\.jeevanlocker\.dev/);
  });

  it('five patients booking one slot at once: exactly one booking, four 409s, one audit row', async () => {
    const slotId = await publishedSlot(doctor);
    const patients = await Promise.all(Array.from({ length: 5 }, () => createUser('patient')));

    const responses = await Promise.all(patients.map((each) => book(each, slotId)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409, 409, 409]);
    const winner = patients[responses.findIndex((response) => response.status === 200)];
    expect((await AppointmentSlot.findById(slotId).lean())!.patientId?.toString()).toBe(idOf(winner));
    expect(await audits('APPOINTMENT_BOOKED', slotId)).toBe(1);
  });

  it('only the slot’s doctor can cancel it: another doctor 403 and the slot stays; the doctor cancels a booked slot and the booking ends', async () => {
    const slotId = await publishedSlot(doctor);
    expect((await book(patient, slotId)).status).toBe(200);

    const stranger = await call('delete', `/api/appointments/slots/${slotId}`, tokenFor(otherDoctor));
    expect(stranger.status).toBe(403);
    expect(stranger.body).toEqual({ message: 'You can only cancel your own slots' });
    expect(await statusOf(slotId)).toBe('BOOKED');
    expect(await audits('APPOINTMENT_SLOT_CANCELLED', slotId)).toBe(0);

    const cancelled = await call('delete', `/api/appointments/slots/${slotId}`, tokenFor(doctor));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.slot.status).toBe('CANCELLED');
    expect(await audits('APPOINTMENT_SLOT_CANCELLED', slotId)).toBe(1);
    expect((await call('get', '/api/appointments/my', tokenFor(patient))).body.slots.map((slot: { id: string }) => slot.id)).not.toContain(slotId);

    // CANCELLED is terminal: no second cancel, no booking.
    expect((await call('delete', `/api/appointments/slots/${slotId}`, tokenFor(doctor))).status).toBe(409);
    expect((await book(otherPatient, slotId)).status).toBe(409);
    expect(await statusOf(slotId)).toBe('CANCELLED');
  });

  it('only the booking patient can cancel the booking: another patient 403; the owner’s cancel reopens the slot for others', async () => {
    const slotId = await publishedSlot(doctor);
    expect((await book(patient, slotId)).status).toBe(200);

    const stranger = await call('patch', `/api/appointments/slots/${slotId}/cancel-booking`, tokenFor(otherPatient));
    expect(stranger.status).toBe(403);
    expect(stranger.body).toEqual({ message: 'You can only cancel your own booking' });
    expect((await AppointmentSlot.findById(slotId).lean())!.patientId?.toString()).toBe(idOf(patient));

    const own = await call('patch', `/api/appointments/slots/${slotId}/cancel-booking`, tokenFor(patient));
    expect(own.status).toBe(200);
    expect(own.body.slot).toMatchObject({ status: 'OPEN' });
    expect(own.body.slot).not.toHaveProperty('patient');
    expect(await audits('APPOINTMENT_BOOKING_CANCELLED', slotId)).toBe(1);
    expect((await call('patch', `/api/appointments/slots/${slotId}/cancel-booking`, tokenFor(patient))).status).toBe(403);

    expect((await book(otherPatient, slotId)).status).toBe(200);
  });

  it('roles: a doctor cannot book, a patient cannot publish or cancel a slot, and an unverified doctor cannot publish — nothing is created', async () => {
    const slotId = await publishedSlot(doctor);
    expect((await book(otherDoctor, slotId)).status).toBe(403);
    expect((await call('delete', `/api/appointments/slots/${slotId}`, tokenFor(patient))).status).toBe(403);
    expect((await publish(patient, { startsAt: futureStart(), durationMinutes: 30 })).status).toBe(403);

    const unverified = await createUser('doctor', { verified: false });
    const refused = await publish(unverified, { startsAt: futureStart(), durationMinutes: 30 });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ message: UNVERIFIED_DOCTOR_MESSAGE });
    expect(await AppointmentSlot.countDocuments({ doctorId: unverified._id })).toBe(0);
    expect(await statusOf(slotId)).toBe('OPEN');
  });

  it('validation: a past start, one beyond 90 days, a bad length and an overlap are refused and create nothing', async () => {
    const solo = await createUser('doctor');
    const start = futureStart();
    expect((await publish(solo, { startsAt: start, durationMinutes: 60 })).status).toBe(201);

    for (const [label, body, status] of [
      ['in the past', { startsAt: new Date(Date.now() - HOUR).toISOString(), durationMinutes: 30 }, 400],
      ['beyond 90 days', { startsAt: new Date(Date.now() + 91 * 24 * HOUR).toISOString(), durationMinutes: 30 }, 400],
      ['not a date', { startsAt: 'tomorrow', durationMinutes: 30 }, 400],
      ['too short', { startsAt: futureStart(), durationMinutes: 5 }, 400],
      ['too long', { startsAt: futureStart(), durationMinutes: 121 }, 400],
      ['fractional', { startsAt: futureStart(), durationMinutes: 30.5 }, 400],
      ['same start', { startsAt: start, durationMinutes: 30 }, 409],
      ['overlapping', { startsAt: new Date(new Date(start).getTime() + 30 * 60_000).toISOString(), durationMinutes: 60 }, 409],
    ] as const) {
      expect((await publish(solo, body)).status, label).toBe(status);
    }
    expect(await AppointmentSlot.countDocuments({ doctorId: solo._id })).toBe(1);
  });

  it('the available list holds only open, future slots of verified doctors; a slot of a doctor unverified since is not bookable', async () => {
    const lapsing = await createUser('doctor');
    const slotId = await publishedSlot(lapsing);
    const past = await AppointmentSlot.create({ doctorId: doctor._id, startsAt: new Date(Date.now() - 2 * HOUR), endsAt: new Date(Date.now() - HOUR), status: 'OPEN' });

    let ids = (await call('get', '/api/appointments/available', tokenFor(patient))).body.slots.map((slot: { id: string }) => slot.id);
    expect(ids).toContain(slotId);
    expect(ids).not.toContain(past._id.toString());
    expect((await book(patient, past._id.toString())).status).toBe(409);

    await User.updateOne({ _id: lapsing._id }, { $set: { verified: false } });
    ids = (await call('get', '/api/appointments/available', tokenFor(patient))).body.slots.map((slot: { id: string }) => slot.id);
    expect(ids).not.toContain(slotId);
    expect((await book(patient, slotId)).status).toBe(409);
    expect(await statusOf(slotId)).toBe('OPEN');
  });

  it('a doctor lists only their own slots; a patient lists only their own bookings; unknown and malformed ids are 404 and 400', async () => {
    const mine = await publishedSlot(otherDoctor);
    const theirs = await publishedSlot(doctor);
    expect((await book(otherPatient, theirs)).status).toBe(200);

    const otherDoctorSlots = (await call('get', '/api/appointments/slots', tokenFor(otherDoctor))).body.slots as Array<{ id: string; doctor: { id: string } }>;
    expect(otherDoctorSlots.map((slot) => slot.id)).toContain(mine);
    expect(otherDoctorSlots.every((slot) => slot.doctor.id === idOf(otherDoctor))).toBe(true);

    const patientBookings = (await call('get', '/api/appointments/my', tokenFor(patient))).body.slots as Array<{ id: string; patient: { id: string } }>;
    expect(patientBookings.map((slot) => slot.id)).not.toContain(theirs);
    expect(patientBookings.every((slot) => slot.patient.id === idOf(patient))).toBe(true);

    expect((await book(patient, '0123456789abcdef01234567')).status).toBe(404);
    expect((await book(patient, 'nope')).status).toBe(400);
    expect((await call('delete', '/api/appointments/slots/0123456789abcdef01234567', tokenFor(doctor))).status).toBe(404);
  });
});
