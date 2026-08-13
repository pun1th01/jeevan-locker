import { api } from '../lib/api';
import type { EmergencyAccess, EmergencyAccessTarget, GrantEmergencyAccessInput } from '../types/emergencyAccess';

interface EmergencyAccessTargetsResponse {
  targets: EmergencyAccessTarget[];
}

interface GrantEmergencyAccessResponse {
  message: string;
  emergencyAccess: EmergencyAccess;
}

export const emergencyAccessService = {
  async getTargets(): Promise<EmergencyAccessTarget[]> {
    const { data } = await api.get<EmergencyAccessTargetsResponse>('/emergency-access/targets');
    return data.targets;
  },

  async grant(input: GrantEmergencyAccessInput): Promise<GrantEmergencyAccessResponse> {
    const { data } = await api.post<GrantEmergencyAccessResponse>('/emergency-access', input);
    return data;
  },
};
