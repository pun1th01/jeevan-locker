import { api } from '../lib/api';
import type {
  LabLink,
  LabLinkResponse,
  LabLinksResponse,
  RequestLabLinkInput,
  UploadLabReportInput,
} from '../types/lab';
import type { MedicalDocument } from '../types/document';

const appendOptionalText = (formData: FormData, field: string, value: string | undefined) => {
  const trimmedValue = value?.trim();

  if (trimmedValue) {
    formData.append(field, trimmedValue);
  }
};

export const labService = {
  async requestLink({ query }: RequestLabLinkInput): Promise<LabLink> {
    const { data } = await api.post<LabLinkResponse>('/lab-links', { query: query.trim() });
    return data.link;
  },

  async getLinks(): Promise<LabLink[]> {
    const { data } = await api.get<LabLinksResponse>('/lab-links');
    return data.links;
  },

  async uploadReport(
    input: UploadLabReportInput,
    onProgress?: (progress: number) => void
  ): Promise<MedicalDocument> {
    const formData = new FormData();
    formData.append('file', input.file);
    formData.append('patientId', input.patientId);
    formData.append('title', input.title.trim());
    appendOptionalText(formData, 'labName', input.labName);
    appendOptionalText(formData, 'testName', input.testName);
    appendOptionalText(formData, 'nablCertNumber', input.nablCertNumber);
    appendOptionalText(formData, 'authorizingDoctorName', input.authorizingDoctorName);
    appendOptionalText(formData, 'hospitalName', input.hospitalName);
    appendOptionalText(formData, 'reportDate', input.reportDate);

    if (input.testValues.length > 0) {
      formData.append('testValues', JSON.stringify(input.testValues));
    }

    const { data } = await api.post<{ document: MedicalDocument }>('/lab/reports', formData, {
      onUploadProgress: (progressEvent) => {
        if (!progressEvent.total || !onProgress) {
          return;
        }

        onProgress(Math.min(100, Math.round((progressEvent.loaded * 100) / progressEvent.total)));
      },
    });

    return data.document;
  },
};
