import { api } from '../lib/api';
import type { ConsentGrant, RequestConsentInput } from '../types/consent';

interface ConsentsResponse {
  consents: ConsentGrant[];
}

interface ConsentResponse {
  message: string;
  consent: ConsentGrant;
}

export const consentService = {
  async getMine(): Promise<ConsentGrant[]> {
    const { data } = await api.get<ConsentsResponse>('/consents/my');
    return data.consents;
  },
  async getReceived(): Promise<ConsentGrant[]> {
    const { data } = await api.get<ConsentsResponse>('/consents/received');
    return data.consents;
  },
  async request(input: RequestConsentInput): Promise<ConsentResponse> {
    const { data } = await api.post<ConsentResponse>('/consents/request', input);
    return data;
  },
  async approve(consentId: string): Promise<ConsentResponse> {
    const { data } = await api.patch<ConsentResponse>(`/consents/${consentId}/approve`);
    return data;
  },
  async reject(consentId: string): Promise<ConsentResponse> {
    const { data } = await api.patch<ConsentResponse>(`/consents/${consentId}/reject`);
    return data;
  },
  async revoke(consentId: string): Promise<ConsentResponse> {
    const { data } = await api.patch<ConsentResponse>(`/consents/${consentId}/revoke`);
    return data;
  },
};
