import { api } from '../lib/api';
import type { AuditSummary } from '../types/audit';

interface AuditSummaryResponse {
  summary: AuditSummary;
}

export const auditService = {
  async getSummary(): Promise<AuditSummary> {
    const { data } = await api.get<AuditSummaryResponse>('/audit/summary');
    return data.summary;
  },
};
