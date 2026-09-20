import { api } from '../lib/api';
import type { PatientLookupResult } from '../types/patient';

export const patientService = {
  /**
   * Exact-match lookup by email or ObjectId. Doctor only.
   * 404 → no patient for that query (same response whether the email is unknown or belongs to a non-patient).
   */
  async lookup(query: string): Promise<PatientLookupResult> {
    const { data } = await api.get<PatientLookupResult>('/patients/lookup', { params: { query: query.trim() } });
    return data;
  },
};
