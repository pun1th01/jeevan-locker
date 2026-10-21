import { CalendarCheck, CalendarX, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getApiErrorMessage, getApiErrorStatus } from '../../lib/api';
import { appointmentService } from '../../services/appointment.service';
import type { AppointmentSlot } from '../../types/appointment';
import { Button } from '../ui/button';
import { formatSlotTime } from './formatSlotTime';

/**
 * A patient's appointments: the slots verified doctors have published, and their own bookings.
 * Booking is first come, first served; if someone else took the slot a moment earlier the list simply refreshes.
 * Self-contained (fetches its own data), so mounting it costs one line. docs/API_APPOINTMENTS.md.
 */

const NOTICE_TIMEOUT_MS = 6_000;

const doctorLabel = (slot: AppointmentSlot) => (slot.doctor.organisation ? `${slot.doctor.name} · ${slot.doctor.organisation}` : slot.doctor.name);

export default function PatientAppointmentsPanel() {
  const [available, setAvailable] = useState<AppointmentSlot[]>([]);
  const [bookings, setBookings] = useState<AppointmentSlot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // "Upcoming" is judged against the time of the last load, never by reading the clock during render.
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const [open, mine] = await Promise.all([appointmentService.getAvailableSlots(), appointmentService.getMyBookings()]);
      setAvailable(open);
      setBookings(mine);
      setNow(Date.now());
      setError(null);
    } catch (requestError) {
      setError(getApiErrorMessage(requestError));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timeoutId = window.setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  const upcomingBookings = useMemo(() => bookings.filter((slot) => new Date(slot.endsAt).getTime() > now), [bookings, now]);

  const act = async (slot: AppointmentSlot, action: 'book' | 'cancel') => {
    setActingId(slot.id);
    setError(null);

    try {
      if (action === 'book') {
        await appointmentService.book(slot.id);
        setNotice(`Booked with ${slot.doctor.name}: ${formatSlotTime(slot)}.`);
      } else {
        await appointmentService.cancelBooking(slot.id);
        setNotice(`Your appointment with ${slot.doctor.name} was cancelled.`);
      }
    } catch (requestError) {
      if (getApiErrorStatus(requestError) === 409) setNotice('That slot was just taken or changed. The list is up to date.');
      else setError(getApiErrorMessage(requestError));
    } finally {
      setActingId(null);
      await load();
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-cyan-300/10">
            <CalendarCheck className="h-5 w-5 text-cyan-200" />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-white">Appointments</h2>
            <p className="mt-1 text-sm text-slate-400">Book a time a verified doctor has published, or cancel one you booked.</p>
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => void load()} disabled={isLoading}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {notice ? <div className="mt-4 rounded-md border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-sm text-cyan-100">{notice}</div> : null}
      {error ? <div className="mt-4 rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-100">{error}</div> : null}

      {isLoading ? (
        <div className="mt-5 flex items-center gap-2 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading appointments&hellip;
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          <section aria-label="Your appointments">
            <h3 className="text-sm font-semibold text-slate-200">Your appointments ({upcomingBookings.length})</h3>
            {upcomingBookings.length > 0 ? (
              <div className="mt-3 space-y-2">
                {upcomingBookings.map((slot) => (
                  <div key={slot.id} className="flex flex-col gap-2 rounded-md border border-cyan-300/20 bg-cyan-300/[0.04] p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-slate-100">
                      {formatSlotTime(slot)} <span className="text-slate-400">· {doctorLabel(slot)}</span>
                    </span>
                    <Button type="button" variant="secondary" size="sm" onClick={() => void act(slot, 'cancel')} disabled={actingId === slot.id}>
                      {actingId === slot.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarX className="h-4 w-4" />}
                      Cancel booking
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-4 text-sm text-slate-400">No upcoming appointments.</p>
            )}
          </section>

          <section aria-label="Available slots">
            <h3 className="text-sm font-semibold text-slate-200">Available slots ({available.length})</h3>
            {available.length > 0 ? (
              <div className="mt-3 space-y-2">
                {available.map((slot) => (
                  <div key={slot.id} className="flex flex-col gap-2 rounded-md border border-white/10 bg-slate-950/50 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-slate-100">
                      {formatSlotTime(slot)} <span className="text-slate-400">· {doctorLabel(slot)}</span>
                    </span>
                    <Button type="button" size="sm" onClick={() => void act(slot, 'book')} disabled={actingId === slot.id}>
                      {actingId === slot.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarCheck className="h-4 w-4" />}
                      Book
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-4 text-sm text-slate-400">No open slots right now.</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
