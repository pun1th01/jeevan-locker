import axios from 'axios';
import { api } from '../lib/api';
import type { User } from '../types/auth';
import type { MedicalDocument, UploadDocumentInput } from '../types/document';

interface DocumentResponse {
  document: MedicalDocument;
}

interface DocumentListResponse {
  documents: MedicalDocument[];
}

interface DoctorListResponse {
  doctors: User[];
}

const throwBlobResponseError = async (error: unknown): Promise<never> => {
  if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
    const responseText = await error.response.data.text();
    let parsedMessage: string | undefined;

    try {
      const parsed = JSON.parse(responseText) as { message?: string };
      parsedMessage = parsed.message;
    } catch {
      parsedMessage = undefined;
    }

    if (parsedMessage) {
      throw new Error(parsedMessage);
    }

    if (responseText) {
      throw new Error(responseText);
    }
  }

  throw error;
};

export const documentService = {
  async getMyDocuments(): Promise<MedicalDocument[]> {
    const { data } = await api.get<DocumentListResponse>('/documents/my-documents');
    return data.documents;
  },

  async getDocument(documentId: string): Promise<MedicalDocument> {
    const { data } = await api.get<DocumentResponse>(`/documents/${documentId}`);
    return data.document;
  },

  async getDocumentPreviewBlob(documentId: string, signal?: AbortSignal): Promise<Blob> {
    try {
      const { data } = await api.get<Blob>(`/documents/${documentId}/view`, {
        responseType: 'blob',
        signal,
      });
      return data;
    } catch (error) {
      return throwBlobResponseError(error);
    }
  },

  async downloadDocumentFile(document: MedicalDocument): Promise<void> {
    const data = await api
      .get<Blob>(`/documents/${document.id}/download`, {
        responseType: 'blob',
      })
      .then((response) => response.data)
      .catch(throwBlobResponseError);

    const objectUrl = URL.createObjectURL(data);
    const link = window.document.createElement('a');
    link.href = objectUrl;
    link.download = document.originalFileName;
    window.document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  },

  async uploadDocument(
    { title, file }: UploadDocumentInput,
    onProgress?: (progress: number) => void
  ): Promise<MedicalDocument> {
    const formData = new FormData();
    formData.append('title', title);
    formData.append('file', file);

    const { data } = await api.post<DocumentResponse>('/documents/upload', formData, {
      onUploadProgress: (progressEvent) => {
        if (!progressEvent.total || !onProgress) {
          return;
        }

        onProgress(Math.min(100, Math.round((progressEvent.loaded * 100) / progressEvent.total)));
      },
    });
    return data.document;
  },

  async shareDocument(documentId: string, doctorId: string): Promise<MedicalDocument> {
    const { data } = await api.patch<DocumentResponse>(`/documents/${documentId}/share`, { doctorId });
    return data.document;
  },

  async getDoctors(): Promise<User[]> {
    const { data } = await api.get<DoctorListResponse>('/documents/doctors');
    return data.doctors;
  },
};
