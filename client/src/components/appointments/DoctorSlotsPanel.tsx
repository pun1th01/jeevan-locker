import { CalendarClock, CalendarPlus, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { getApiErrorMessage, getApiErrorStatus } from '../../lib/api';
import { cn } from '../../lib/utils';
import { appointmentService } from '../../services/appointment.service';
import type { AppointmentSlot } from '../../types/appointment';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { formatSlotTime } from './formatSlotTime';

/**
 * A doctor's appointment slots: publish a time a patient can book, see who booked what, cancel a slot.
 * Self-contained (fetches its own data), so mounting it costs one line. docs/API_APPOINTMENTS.md.
 */

const DURATIONS = [15, 30, 45, 60] as const;
const NOTICE_TIMEOUT_MS = 6_000;

/** `datetime-local` wants local time without a zone; default to the next full hour. */
const nextHourLocal = () => {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`;
};

const STATUS_STYLE: Record<AppointmentSlot['status'], string> = {
  OPEN: 'bg-emerald-300/10 text-emerald-100',
  BOOKED: 'bg-cyan-300/10 text-cyan-100',
  CANCELLED: 'bg-white/[0.06] text-slate-400',
};

export default function DoctorSlotsPanel() {
  const [slots, setSlots] = useState<AppointmentSlot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [startsAt, setStartsAt] = useState(nextHourLocal);
  const [durationMinutes, setDurationMinutes] = useState<number>(30);
  const [isPublishing, setIsPublishing] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // "Upcoming" is judged against the time of the last load, never by reading the clock during render.
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setSlots(await appointmentService.getMySlots());
      setNow(Date.now());
      setError(null);
    } catch (requestError) {
      setError(getApiErrorMessage(requestError));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred by a tick, not run in the effect body (same shape as the other self-loading panels).
    const timeoutId = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timeoutId = window.setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  const upcoming = useMemo(() => slots.filter((slot) => slot.status !== 'CANCELLED' && new Date(slot.endsAt).getTime() > now), [slots, now]);

  const handlePublish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsPublishing(true);
    setError(null);

    try {
      const slot = await appointmentService.publishSlot({ startsAt: new Date(startsAt).toISOString(), durationMinutes });
      setNotice(`Slot published: ${formatSlotTime(slot)}.`);
      await load();
    } catch (requestError) {
      setError(getApiErrorMessage(requestError));
    } finally {
      setIsPublishing(false);
    }
  };

  const handleCancel = async (slot: AppointmentSlot) => {
    setCancellingId(slot.id);
    setError(null);

    try {
      await appointmentService.cancelSlot(slot.id);
      setNotice(slot.patient ? `Cancelled. ${slot.patient.name}'s booking was cancelled with it.` : 'Slot cancelled.');
    } catch (requestError) {
      if (getApiErrorStatus(requestError) === 409) setNotice('That slot was already cancelled.');
      else setError(getApiErrorMessage(requestError));
    } finally {
      setCancellingId(null);
      await load();
    }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-cyan-300/10">
            <CalendarClock className="h-5 w-5 text-cyan-200" />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-white">Appointment slots</h2>
            <p className="mt-1 text-sm text-slate-400">Publish times patients can book. Booked slots show the patient&rsquo;s name.</p>
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => void load()} disabled={isLoading}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      <form className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(event) => void handlePublish(event)}>
        <label className="block flex-1 text-sm font-medium text-slate-200">
          Starts at
          <Input type="datetime-local" className="mt-2" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} required />
        </label>
        <label className="block text-sm font-medium text-slate-200">
          Length
          <select
            value={durationMinutes}
            onChange={(event) => setDurationMinutes(Number(event.target.value))}
            className="mt-2 h-10 w-full rounded-md border border-white/10 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-emerald-300 sm:w-32"
          >
            {DURATIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} min
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" disabled={isPublishing}>
          {isPublishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarPlus className="h-4 w-4" />}
          Publish slot
        </Button>
      </form>

      {notice ? <div className="mt-4 rounded-md border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-sm text-cyan-100">{notice}</div> : null}
      {error ? <div className="mt-4 rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-100">{error}</div> : null}

      {isLoading ? (
        <div className="mt-5 flex items-center gap-2 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading slots&hellip;
        </div>
      ) : upcoming.length > 0 ? (
        <div className="mt-5 space-y-2">
          {upcoming.map((slot) => (
            <div key={slot.id} className="flex flex-col gap-2 rounded-md border border-white/10 bg-slate-950/50 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-100">{formatSlotTime(slot)}</span>
                <span className={cn('rounded-md px-2 py-0.5 text-xs font-semibold', STATUS_STYLE[slot.status])}>{slot.status}</span>
                {slot.patient ? <span className="text-slate-300">· {slot.patient.name}</span> : null}
              </div>
              <Button type="button" variant="secondary" size="sm" onClick={() => void handleCancel(slot)} disabled={cancellingId === slot.id}>
                {cancellingId === slot.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                Cancel
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-5 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-4 text-sm text-slate-400">No upcoming slots.</p>
      )}
    </div>
  );
}
