# JeevanLocker — Appointment slots API

A deliberately small booking feature: a verified doctor publishes a time, a patient books it, either side can withdraw. Base path `/api/appointments`; every route needs `Authorization: Bearer <token>`. The UI is the *Appointment slots* panel on the doctor dashboard and the *Appointments* panel on the patient dashboard.

---

## 1. The slot

```ts
type AppointmentSlotStatus = 'OPEN' | 'BOOKED' | 'CANCELLED';

interface AppointmentSlot {
  id: string;
  doctor: { id: string; name: string; organisation?: string };
  startsAt: string;            // ISO 8601
  endsAt: string;              // startsAt + durationMinutes
  status: AppointmentSlotStatus;
  patient?: { id: string; name: string };   // to the slot's doctor once booked, and to the patient who booked it
  bookedAt?: string;
  cancelledAt?: string;
}
```

No response carries anyone's email or account details. The available list never names a patient.

```
OPEN ──book──▶ BOOKED ──patient cancels booking──▶ OPEN
  │               │
  └──doctor cancels──┴──▶ CANCELLED (terminal)
```

Every transition is one status-guarded write (`updateOne({ _id, status: … })`, success only when it changed the row). Of five patients booking one slot at once, exactly one gets it. The database holds at most one live (`OPEN`/`BOOKED`) slot per doctor per start time (`one_live_slot_per_doctor_start`); the handler also refuses overlapping slots.

## 2. Doctors

| Route | Who | Body / result |
|---|---|---|
| `POST /slots` | **verified** doctor | `{ startsAt: ISO string, durationMinutes: 10–120 (whole) }`. Starts in the future and within 90 days; must not overlap the doctor's other live slots. `201 { message: 'Slot published', slot }`. |
| `GET /slots` | doctor (verified or not) | `{ slots }`: the caller's own slots, every status, soonest first, at most 200. |
| `DELETE /slots/:id` | doctor (owner) | `OPEN`/`BOOKED` → `CANCELLED`. A booked slot's booking ends with it. `200 { message: 'Slot cancelled', slot }`. |

Errors: `400` for a malformed id or body (`startsAt must be an ISO 8601 date and time`, `durationMinutes must be a whole number from 10 to 120`, `A slot must start in the future and within 90 days`); `409 This slot overlaps another of your slots`; `404 Slot not found`; `403 You can only cancel your own slots`; `409 This slot is already cancelled`. An unverified doctor's `POST` is `403` with the verification message, as for every doctor-initiated action (API_ADMIN.md §3).

## 3. Patients

| Route | Who | Result |
|---|---|---|
| `GET /available` | patient | `{ slots }`: `OPEN` slots starting in the future, of doctors who are verified **now**, soonest first, at most 200. |
| `GET /my` | patient | `{ slots }`: the caller's current bookings (`BOOKED`), soonest first. |
| `PATCH /slots/:id/book` | patient | `OPEN` and future → `BOOKED` by the caller. `200 { message: 'Appointment booked', slot }`. |
| `PATCH /slots/:id/cancel-booking` | patient (who booked it) | `BOOKED` → `OPEN`, free for others. `200 { message: 'Booking cancelled', slot }` (no `patient` on it any more). |

Errors: `400 A valid slot ID is required`; `404 Slot not found`; `409 This slot is no longer available` (booked by someone else, cancelled, already started, or its doctor is no longer verified); `403 You can only cancel your own booking`; `409 This booking is no longer active`.

## 4. Audit

`APPOINTMENT_SLOT_PUBLISHED`, `APPOINTMENT_SLOT_CANCELLED` (actor the doctor), `APPOINTMENT_BOOKED`, `APPOINTMENT_BOOKING_CANCELLED` (actor the patient). Metadata: `{ slotId, doctorId, startsAt }`, plus `patientId` where a patient is involved and `endsAt` on publish. A refused request writes nothing. Slots are not anchored on-chain and emit no notification events. Both would be natural next steps; neither is needed for the feature to be correct.

Tests: TESTING.md C61 (`server/test/access/appointments.test.ts`); every route has a row in the route inventory (C1–C3).
