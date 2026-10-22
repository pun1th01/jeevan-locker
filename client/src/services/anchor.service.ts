import { api } from '../lib/api';
import type { AnchorListResponse, AnchorRecordType, AnchorVerification, ChainAnchorRow, ChainAnchorStatus } from '../types/anchor';

export const anchorService = {
  async list(params: { status?: ChainAnchorStatus; recordType?: AnchorRecordType; limit?: number } = {}): Promise<AnchorListResponse> {
    const { data } = await api.get<AnchorListResponse>('/admin/anchors', { params });
    return data;
  },
  async verify(anchorId: string): Promise<AnchorVerification> {
    const { data } = await api.get<AnchorVerification>(`/admin/anchors/${anchorId}/verify`);
    return data;
  },
  async retry(anchorId: string): Promise<ChainAnchorRow> {
    const { data } = await api.post<{ anchor: ChainAnchorRow }>(`/admin/anchors/${anchorId}/retry`);
    return data.anchor;
  },
};
