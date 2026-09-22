import { CheckCircle2, FileCheck2, Loader2, Share2, Upload, UsersRound, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import DashboardShell from '../../components/dashboard/DashboardShell';
import DocumentList from '../../components/documents/DocumentList';
import DocumentPreviewModal from '../../components/documents/DocumentPreviewModal';
import DocumentUploadModal from '../../components/documents/DocumentUploadModal';
import EmergencyAccessPanel from '../../components/emergency/EmergencyAccessPanel';
import { Button } from '../../components/ui/button';
import { getApiErrorMessage } from '../../lib/api';
import { documentService } from '../../services/document.service';
import { consentService } from '../../services/consent.service';
import type { User } from '../../types/auth';
import type { MedicalDocument, UploadDocumentInput } from '../../types/document';
import type { ConsentGrant } from '../../types/consent';

export default function PatientDashboard() {
  const [documents, setDocuments] = useState<MedicalDocument[]>([]);
  const [doctors, setDoctors] = useState<User[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<MedicalDocument | null>(null);
  const [previewDocument, setPreviewDocument] = useState<MedicalDocument | null>(null);
  const [selectedDoctorByDocument, setSelectedDoctorByDocument] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [openingDocumentId, setOpeningDocumentId] = useState<string | null>(null);
  const [sharingDocumentId, setSharingDocumentId] = useState<string | null>(null);
  const [newDocumentId, setNewDocumentId] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [consents, setConsents] = useState<ConsentGrant[]>([]);
  const [consentActionId, setConsentActionId] = useState<string | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);

  const loadDashboardData = useCallback(async () => {
    setIsLoading(true);
    setPageError(null);

    try {
      const [documentList, doctorList, receivedConsents] = await Promise.all([
        documentService.getMyDocuments(),
        documentService.getDoctors(),
        consentService.getReceived(),
      ]);
      setDocuments(documentList);
      setDoctors(doctorList);
      setConsents(receivedConsents);
    } catch (error) {
      setPageError(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboardData();
  }, [loadDashboardData]);

  const sharedDoctorCount = useMemo(
    () => new Set(documents.flatMap((document) => document.sharedWithDoctors.map((doctor) => doctor.id))).size,
    [documents]
  );

  const metrics = useMemo(
    () => [
      { label: 'Uploaded records', value: String(documents.length), tone: 'text-emerald-300' },
      { label: 'Doctor shares', value: String(sharedDoctorCount), tone: 'text-cyan-300' },
      { label: 'Available doctors', value: String(doctors.length), tone: 'text-amber-300' },
    ],
    [documents.length, doctors.length, sharedDoctorCount]
  );

  useEffect(() => {
    if (!successMessage) {
      return;
    }

    const timeoutId = window.setTimeout(() => setSuccessMessage(null), 4200);
    return () => window.clearTimeout(timeoutId);
  }, [successMessage]);

  useEffect(() => {
    if (!newDocumentId) {
      return;
    }

    const timeoutId = window.setTimeout(() => setNewDocumentId(null), 6500);
    return () => window.clearTimeout(timeoutId);
  }, [newDocumentId]);

  const handleUpload = async (input: UploadDocumentInput, onProgress: (progress: number) => void) => {
    setIsUploading(true);
    setUploadError(null);

    try {
      const uploadedDocument = await documentService.uploadDocument(input, onProgress);
      const refreshedDocuments = await documentService.getMyDocuments();
      const refreshedDocument = refreshedDocuments.find((document) => document.id === uploadedDocument.id);

      setDocuments(refreshedDocuments);
      setSelectedDocument(refreshedDocument ?? uploadedDocument);
      setNewDocumentId(uploadedDocument.id);
      setSuccessMessage(`${uploadedDocument.title} was added to your vault.`);
    } catch (error) {
      setUploadError(getApiErrorMessage(error));
      throw error;
    } finally {
      setIsUploading(false);
    }
  };

  const handleOpenDocument = async (documentId: string) => {
    setOpeningDocumentId(documentId);
    setPageError(null);

    try {
      const document = await documentService.getDocument(documentId);
      setSelectedDocument(document);
      setDocuments((currentDocuments) =>
        currentDocuments.map((currentDocument) => (currentDocument.id === document.id ? document : currentDocument))
      );
    } catch (error) {
      setPageError(getApiErrorMessage(error));
    } finally {
      setOpeningDocumentId(null);
    }
  };

  const handleShare = async (documentId: string) => {
    const doctorId = selectedDoctorByDocument[documentId];

    if (!doctorId) {
      setShareError('Select a doctor before sharing the document');
      return;
    }

    setSharingDocumentId(documentId);
    setShareError(null);

    try {
      const updatedDocument = await documentService.shareDocument(documentId, doctorId);
      setDocuments((currentDocuments) =>
        currentDocuments.map((document) => (document.id === updatedDocument.id ? updatedDocument : document))
      );
      setSelectedDocument(updatedDocument);
      setSelectedDoctorByDocument((currentSelection) => ({ ...currentSelection, [documentId]: '' }));
      setSuccessMessage(`${updatedDocument.title} is now shared with the selected doctor.`);
    } catch (error) {
      setShareError(getApiErrorMessage(error));
    } finally {
      setSharingDocumentId(null);
    }
  };

  const handleConsentAction = async (consent: ConsentGrant, action: 'approve' | 'reject' | 'revoke') => {
    setConsentActionId(consent.id);
    setConsentError(null);
    try {
      const result = await consentService[action](consent.id);
      setConsents((currentConsents) =>
        action === 'reject'
          ? currentConsents.filter((currentConsent) => currentConsent.id !== consent.id)
          : currentConsents.map((currentConsent) => (currentConsent.id === consent.id ? result.consent : currentConsent))
      );
      setSuccessMessage(
        action === 'approve'
          ? `Access approved for ${result.consent.doctor.name}.`
          : action === 'revoke'
            ? `Access revoked for ${result.consent.doctor.name}.`
            : 'Access request rejected.'
      );
    } catch (error) {
      setConsentError(getApiErrorMessage(error));
    } finally {
      setConsentActionId(null);
    }
  };

  const renderShareActions = (document: MedicalDocument) => {
    const availableDoctors = doctors.filter(
      (doctor) => !document.sharedWithDoctors.some((sharedDoctor) => sharedDoctor.id === doctor.id)
    );

    if (doctors.length === 0) {
      return <span className="rounded-md bg-white/[0.04] px-2 py-1 text-xs text-slate-500">No doctors registered</span>;
    }

    if (availableDoctors.length === 0) {
      return (
        <span className="rounded-md bg-emerald-300/10 px-2 py-1 text-xs font-semibold text-emerald-100">
          Shared with all doctors
        </span>
      );
    }

    return (
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
        <select
          value={selectedDoctorByDocument[document.id] ?? ''}
          onChange={(event) =>
            setSelectedDoctorByDocument((currentSelection) => ({
              ...currentSelection,
              [document.id]: event.target.value,
            }))
          }
          className="h-9 min-w-0 rounded-md border border-white/10 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-emerald-300 focus:ring-2 focus:ring-emerald-300/20 sm:max-w-44"
          aria-label={`Select doctor for ${document.title}`}
        >
          <option value="">Select doctor</option>
          {availableDoctors.map((doctor) => (
            <option key={doctor.id} value={doctor.id}>
              {doctor.name}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          onClick={() => void handleShare(document.id)}
          disabled={!selectedDoctorByDocument[document.id] || sharingDocumentId === document.id}
        >
          {sharingDocumentId === document.id ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Share2 className="h-4 w-4" />
          )}
          Share
        </Button>
      </div>
    );
  };

  return (
    <>
      <DashboardShell
        title="Patient Dashboard"
        subtitle="Upload medical records, review your vault, and share specific documents with registered doctors."
        metrics={metrics}
      >
        <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Record Vault</h2>
              <p className="mt-1 text-sm text-slate-400">Documents you upload stay linked to your patient account.</p>
            </div>
            <Button
              type="button"
              onClick={() => {
                setUploadError(null);
                setIsUploadOpen(true);
              }}
            >
              <Upload className="h-4 w-4" />
              Upload
            </Button>
          </div>

          {successMessage ? (
            <div className="mt-5 flex items-start gap-2 rounded-md border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-sm text-emerald-100">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{successMessage}</span>
            </div>
          ) : null}

          {pageError ? (
            <div className="mt-5 rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">
              {pageError}
            </div>
          ) : null}

          {shareError ? (
            <div className="mt-5 rounded-md border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
              {shareError}
            </div>
          ) : null}

          {consentError ? (
            <div className="mt-5 rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-100">
              {consentError}
            </div>
          ) : null}

          <DocumentList
            documents={documents}
            isLoading={isLoading}
            emptyTitle="Your record vault is empty"
            emptyMessage="No medical records have been uploaded yet."
            selectedDocumentId={selectedDocument?.id ?? null}
            highlightedDocumentId={newDocumentId}
            openingDocumentId={openingDocumentId}
            onOpenDocument={(documentId) => void handleOpenDocument(documentId)}
            onPreviewDocument={setPreviewDocument}
            renderActions={renderShareActions}
          />
        </div>

        <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-cyan-300/10"><UsersRound className="h-5 w-5 text-cyan-200" /></span>
            <div><h2 className="text-lg font-semibold text-white">Access Requests</h2><p className="mt-1 text-sm text-slate-400">Approve, reject, or revoke doctor access to your records.</p></div>
          </div>
          {consents.length > 0 ? (
            <div className="mt-5 space-y-3">
              {consents.map((consent) => (
                <div key={consent.id} className="rounded-md border border-white/10 bg-slate-950/50 p-4 text-sm">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div><div className="flex flex-wrap items-center gap-2"><p className="font-semibold text-white">{consent.doctor.name}</p><span className="rounded-md bg-cyan-300/10 px-2 py-1 text-xs font-semibold text-cyan-100">{consent.status}</span></div><p className="mt-2 text-slate-300">{consent.document.title}</p><p className="mt-1 text-slate-400">Purpose: {consent.purpose}</p><p className="mt-2 text-xs text-slate-500">Requested {new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(consent.requestedAt))}</p></div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {consent.status === 'PENDING' ? <><Button type="button" variant="secondary" size="sm" onClick={() => void handleConsentAction(consent, 'reject')} disabled={consentActionId === consent.id}><XCircle className="h-4 w-4" />Reject</Button><Button type="button" size="sm" onClick={() => void handleConsentAction(consent, 'approve')} disabled={consentActionId === consent.id}>{consentActionId === consent.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Approve</Button></> : null}
                      {consent.status === 'APPROVED' ? <Button type="button" variant="destructive" size="sm" onClick={() => void handleConsentAction(consent, 'revoke')} disabled={consentActionId === consent.id}>{consentActionId === consent.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}Revoke</Button> : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : <div className="mt-5 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-5 text-sm text-slate-400">No pending document access requests.</div>}
        </div>

        <EmergencyAccessPanel />

        <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
          <h2 className="text-lg font-semibold text-white">Selected Record</h2>
          {selectedDocument ? (
            <div className="mt-5 space-y-4 text-sm">
              <div className="rounded-md border border-emerald-300/15 bg-emerald-300/[0.04] p-4">
                <div className="flex items-center gap-2 text-white">
                  <FileCheck2 className="h-4 w-4 text-emerald-300" />
                  <span className="font-semibold">{selectedDocument.title}</span>
                </div>
                <p className="mt-2 break-all text-slate-400">{selectedDocument.originalFileName}</p>
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-400">
                  <span className="rounded-md bg-white/[0.05] px-2 py-1">{selectedDocument.mimeType}</span>
                  <span className="rounded-md bg-white/[0.05] px-2 py-1">
                    {selectedDocument.sharedWithDoctors.length} doctor shares
                  </span>
                </div>
              </div>

              <div className="rounded-md bg-white/[0.03] p-4">
                <div className="flex items-center gap-2 text-slate-200">
                  <UsersRound className="h-4 w-4 text-cyan-300" />
                  Shared doctors
                </div>
                <div className="mt-3 space-y-2 text-slate-400">
                  {selectedDocument.sharedWithDoctors.length > 0 ? (
                    selectedDocument.sharedWithDoctors.map((doctor) => (
                      <div
                        key={doctor.id}
                        className="flex flex-col gap-1 rounded-md bg-slate-950/50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <span className="font-medium text-slate-200">{doctor.name}</span>
                        <span className="break-all text-xs text-slate-500">{doctor.email}</span>
                      </div>
                    ))
                  ) : (
                    <p className="rounded-md border border-dashed border-white/10 bg-slate-950/40 p-3">
                      No doctors have access yet. Use the share controls on a record to grant access.
                    </p>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-5 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-6 text-sm leading-6 text-slate-400">
              Select a document to review its sharing status and access details.
            </div>
          )}
        </div>
      </DashboardShell>

      <DocumentUploadModal
        isOpen={isUploadOpen}
        isUploading={isUploading}
        error={uploadError}
        onClose={() => setIsUploadOpen(false)}
        onResetError={() => setUploadError(null)}
        onUpload={handleUpload}
      />

      <DocumentPreviewModal
        document={previewDocument}
        isOpen={Boolean(previewDocument)}
        onClose={() => setPreviewDocument(null)}
      />
    </>
  );
}
