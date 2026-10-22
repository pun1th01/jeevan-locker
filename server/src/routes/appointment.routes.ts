import { Router } from 'express';
import {
  bookSlot,
  cancelBooking,
  cancelSlot,
  listAvailableSlots,
  listMyBookings,
  listMySlots,
  publishSlot,
} from '../controllers/appointment.controller';
import { requireRole, requireVerifiedDoctor, verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.use(verifyToken);

// Doctors. Publishing a new slot is gated on verification like every other doctor-initiated action; an unverified
// doctor can still see and cancel slots published while verified.
router.post('/slots', requireRole('doctor'), requireVerifiedDoctor, publishSlot);
router.get('/slots', requireRole('doctor'), listMySlots);
router.delete('/slots/:id', requireRole('doctor'), cancelSlot);

// Patients.
router.get('/available', requireRole('patient'), listAvailableSlots);
router.get('/my', requireRole('patient'), listMyBookings);
router.patch('/slots/:id/book', requireRole('patient'), bookSlot);
router.patch('/slots/:id/cancel-booking', requireRole('patient'), cancelBooking);

export default router;
