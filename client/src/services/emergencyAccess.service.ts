import { api } from '../lib/api';
import type { EmergencyAccess, GrantEmergencyAccessInput } from '../types/emergencyAccess';

interface GrantEmergencyAccessResponse {
  message: string;
  emergencyAccess: EmergencyAccess;
}

export const emergencyAccessService = {
  async grant(input: GrantEmergencyAccessInput): Promise<GrantEmergencyAccessResponse> {
    const { data } = await api.post<GrantEmergencyAccessResponse>('/emergency-access', input);
    return data;
  },
};
