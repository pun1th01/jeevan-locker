import type { AppointmentSlot } from '../../types/appointment';

/** "Tue, 21 Oct, 10:00 am – 10:30 am" in the viewer's local time. */
export const formatSlotTime = (slot: Pick<AppointmentSlot, 'startsAt' | 'endsAt'>) => {
  const day = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: '2-digit', month: 'short' }).format(new Date(slot.startsAt));
  const time = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time.format(new Date(slot.startsAt))} – ${time.format(new Date(slot.endsAt))}`;
};
