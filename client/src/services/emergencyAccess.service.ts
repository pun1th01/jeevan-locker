import { api } from '../lib/api';
import type { EmergencyAccess, EmergencyAccessStatus, GrantEmergencyAccessInput } from '../types/emergencyAccess';

interface GrantEmergencyAccessResponse {
  message: string;
  emergencyAccess: EmergencyAccess;
}

export const emergencyAccessService = {
  async grant(input: GrantEmergencyAccessInput): Promise<GrantEmergencyAccessResponse> {
    const { data } = await api.post<GrantEmergencyAccessResponse>('/emergency-access', input);
    return data;
  },

  /** Patient: grants on their documents. Doctor: their own. Default is live grants only. */
  async list(status: EmergencyAccessStatus | 'all' = 'ACTIVE'): Promise<EmergencyAccess[]> {
    const { data } = await api.get<{ emergencyAccesses: EmergencyAccess[] }>('/emergency-access', { params: { status } });
    return data.emergencyAccesses;
  },

  /** Patient ends a live grant immediately. */
  async revoke(emergencyAccessId: string): Promise<EmergencyAccess> {
    const { data } = await api.delete<{ emergencyAccess: EmergencyAccess }>(`/emergency-access/${emergencyAccessId}`);
    return data.emergencyAccess;
  },
};
