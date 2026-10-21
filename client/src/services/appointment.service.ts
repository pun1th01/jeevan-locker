import { api } from '../lib/api';
import type { AppointmentSlot, PublishSlotInput } from '../types/appointment';

interface SlotResponse {
  message: string;
  slot: AppointmentSlot;
}

interface SlotListResponse {
  slots: AppointmentSlot[];
}

export const appointmentService = {
  // --- doctor ---
  async publishSlot(input: PublishSlotInput): Promise<AppointmentSlot> {
    const { data } = await api.post<SlotResponse>('/appointments/slots', input);
    return data.slot;
  },

  /** The doctor's own slots, every status, soonest first. */
  async getMySlots(): Promise<AppointmentSlot[]> {
    const { data } = await api.get<SlotListResponse>('/appointments/slots');
    return data.slots;
  },

  async cancelSlot(slotId: string): Promise<AppointmentSlot> {
    const { data } = await api.delete<SlotResponse>(`/appointments/slots/${slotId}`);
    return data.slot;
  },

  // --- patient ---
  /** Open, future slots of verified doctors, soonest first. */
  async getAvailableSlots(): Promise<AppointmentSlot[]> {
    const { data } = await api.get<SlotListResponse>('/appointments/available');
    return data.slots;
  },

  /** The patient's own bookings (booked slots, soonest first). */
  async getMyBookings(): Promise<AppointmentSlot[]> {
    const { data } = await api.get<SlotListResponse>('/appointments/my');
    return data.slots;
  },

  async book(slotId: string): Promise<AppointmentSlot> {
    const { data } = await api.patch<SlotResponse>(`/appointments/slots/${slotId}/book`);
    return data.slot;
  },

  async cancelBooking(slotId: string): Promise<AppointmentSlot> {
    const { data } = await api.patch<SlotResponse>(`/appointments/slots/${slotId}/cancel-booking`);
    return data.slot;
  },
};
