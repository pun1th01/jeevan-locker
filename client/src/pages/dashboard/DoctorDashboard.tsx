import { BadgeAlert, Calendar, CheckCircle2, ClipboardCheck, FileSearch, Mail, Siren, Stethoscope, UserRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuthStore } from '../../store/useAuthStore';
import DashboardShell from '../../components/dashboard/DashboardShell';
import DocumentList from '../../components/documents/DocumentList';
import DocumentPreviewModal from '../../components/documents/DocumentPreviewModal';
import EmergencyAccessModal from '../../components/emergency/EmergencyAccessModal';
import ConsentRequestModal from '../../components/consent/ConsentRequestModal';
import { Button } from '../../components/ui/button';
import { getApiErrorMessage } from '../../lib/api';
import { documentService } from '../../services/document.service';
import { emergencyAccessService } from '../../services/emergencyAccess.service';
import { consentService } from '../../services/consent.service';
import type { MedicalDocument } from '../../types/document';
import type { EmergencyAccess, GrantEmergencyAccessInput } from '../../types/emergencyAccess';
import type { ConsentGrant, RequestConsentInput } from '../../types/consent';

export default function DoctorDashboard() {
  // Mirrors the server gate: unverified doctors get 403 on lookup, consent request, and break-glass.
  const isVerified = useAuthStore((state) => state.user?.verified ?? false);
  const [documents, setDocuments] = useState<MedicalDocument[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<MedicalDocument | null>(null);
  const [previewDocument, setPreviewDocument] = useState<MedicalDocument | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [openingDocumentId, setOpeningDocumentId] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [accessNotice, setAccessNotice] = useState<string | null>(null);
  const [isEmergencyDialogOpen, setIsEmergencyDialogOpen] = useState(false);
  const [isGrantingEmergencyAccess, setIsGrantingEmergencyAccess] = useState(false);
  const [emergencyError, setEmergencyError] = useState<string | null>(null);
  const [emergencyNotice, setEmergencyNotice] = useState<string | null>(null);
  const [activeEmergencyAccess, setActiveEmergencyAccess] = useState<EmergencyAccess | null>(null);
  const [myConsents, setMyConsents] = useState<ConsentGrant[]>([]);
  const [isConsentDialogOpen, setIsConsentDialogOpen] = useState(false);
  const [isRequestingConsent, setIsRequestingConsent] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);

  const formatDate = (value: string) =>
    new Intl.DateTimeFormat('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));

  const loadDocuments = useCallback(async () => {
    setIsLoading(true);
    setPageError(null);

    try {
      setDocuments(await documentService.getMyDocuments());
    } catch (error) {
      setPageError(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadMyConsents = useCallback(async () => {
    try {
      setMyConsents(await consentService.getMine());
    } catch (error) {
      setConsentError(getApiErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadDocuments();
      void loadMyConsents();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [loadDocuments, loadMyConsents]);

  useEffect(() => {
    if (!accessNotice) {
      return;
    }

    const timeoutId = window.setTimeout(() => setAccessNotice(null), 3600);
    return () => window.clearTimeout(timeoutId);
  }, [accessNotice]);

  const patientCount = useMemo(
    () => new Set(documents.map((document) => document.uploadedBy.id)).size,
    [documents]
  );

  const metrics = useMemo(
    () => [
      { label: 'Shared records', value: String(documents.length), tone: 'text-cyan-300' },
      { label: 'Patients represented', value: String(patientCount), tone: 'text-amber-300' },
      { label: 'Selected record', value: selectedDocument ? 'Open' : 'None', tone: 'text-emerald-300' },
    ],
    [documents.length, patientCount, selectedDocument]
  );

  const handleOpenDocument = async (documentId: string) => {
    setOpeningDocumentId(documentId);
    setPageError(null);

    try {
      const document = await documentService.getDocument(documentId);
      setSelectedDocument(document);
      setDocuments((currentDocuments) =>
        currentDocuments.map((currentDocument) => (currentDocument.id === document.id ? document : currentDocument))
      );
      setAccessNotice(`Access logged for ${document.title}.`);
    } catch (error) {
      setPageError(getApiErrorMessage(error));
    } finally {
      setOpeningDocumentId(null);
    }
  };

  const handleGrantEmergencyAccess = async (input: GrantEmergencyAccessInput) => {
    setIsGrantingEmergencyAccess(true);
    setEmergencyError(null);

    try {
      const { emergencyAccess } = await emergencyAccessService.grant(input);
      setActiveEmergencyAccess(emergencyAccess);
      setEmergencyNotice('Emergency access granted. Access expires in 15 minutes and all activity is logged.');

      try {
        const document = await documentService.getDocument(emergencyAccess.documentId);
        setDocuments((currentDocuments) => {
          const alreadyListed = currentDocuments.some((currentDocument) => currentDocument.id === document.id);
          return alreadyListed
            ? currentDocuments.map((currentDocument) => (currentDocument.id === document.id ? document : currentDocument))
            : [document, ...currentDocuments];
        });
        setSelectedDocument(document);
      } catch (error) {
        setPageError(`Emergency access was granted, but the document could not be opened: ${getApiErrorMessage(error)}`);
      }
    } catch (error) {
      setEmergencyError(getApiErrorMessage(error));
      throw error;
    } finally {
      setIsGrantingEmergencyAccess(false);
    }
  };

  const handleRequestConsent = async (input: RequestConsentInput) => {
    setIsRequestingConsent(true);
    setConsentError(null);
    try {
      const { consent } = await consentService.request(input);
      setMyConsents((currentConsents) => [consent, ...currentConsents]);
      setAccessNotice(`Access request sent to ${consent.patient.name}.`);
    } catch (error) {
      setConsentError(getApiErrorMessage(error));
      throw error;
    } finally {
      setIsRequestingConsent(false);
    }
  };

  return (
    <>
      <DashboardShell
        title="Doctor Dashboard"
        subtitle="Review patient-shared records or use the audited emergency workflow for time-limited Break-Glass access."
        metrics={metrics}
      >
      <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-cyan-300/10">
              <Stethoscope className="h-5 w-5 text-cyan-200" />
            </span>
            <div>
              <h2 className="text-lg font-semibold text-white">Patient-Shared Records</h2>
              <p className="mt-1 text-sm text-slate-400">Opening record details creates an auditable access event.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!isVerified}
              title={isVerified ? undefined : 'Available after admin verification'}
              onClick={() => {
                setConsentError(null);
                setIsConsentDialogOpen(true);
              }}
            >
              <ClipboardCheck className="h-4 w-4" />
              Request Access
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={!isVerified}
              title={isVerified ? undefined : 'Available after admin verification'}
              onClick={() => {
                setEmergencyError(null);
                setIsEmergencyDialogOpen(true);
              }}
            >
              <Siren className="h-4 w-4" />
              Emergency Access
            </Button>
          </div>
        </div>

        {!isVerified ? (
          <div className="mt-5 flex items-start gap-2 rounded-md border border-amber-300/25 bg-amber-300/10 px-3 py-3 text-sm text-amber-100">
            <BadgeAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">Account awaiting verification</p>
              <p className="mt-1 leading-6 text-amber-100/85">
                An administrator has to verify your doctor account before you can look up patients, request access, or use
                Emergency Access. Records patients have already shared with you remain available below.
              </p>
            </div>
          </div>
        ) : null}

        {pageError ? (
          <div className="mt-5 rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">
            {pageError}
          </div>
        ) : null}

        {accessNotice ? (
          <div className="mt-5 flex items-start gap-2 rounded-md border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-sm text-emerald-100">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{accessNotice}</span>
          </div>
        ) : null}

        {emergencyNotice && activeEmergencyAccess ? (
          <div className="mt-5 rounded-md border border-rose-300/25 bg-rose-300/10 px-3 py-3 text-sm text-rose-100">
            <div className="flex items-start gap-2">
              <Siren className="mt-0.5 h-4 w-4 shrink-0 text-rose-200" />
              <div>
                <p className="font-semibold">Emergency Access Active</p>
                <p className="mt-1 text-rose-100/85">{emergencyNotice}</p>
                <p className="mt-1 text-xs text-rose-100/70">Expires: {formatDate(activeEmergencyAccess.expiresAt)}</p>
              </div>
            </div>
          </div>
        ) : null}

        <DocumentList
          documents={documents}
          isLoading={isLoading}
          emptyTitle="No shared records"
          emptyMessage="Patient-shared medical documents will appear here after access is granted."
          selectedDocumentId={selectedDocument?.id ?? null}
          openingDocumentId={openingDocumentId}
          onOpenDocument={(documentId) => void handleOpenDocument(documentId)}
          onPreviewDocument={setPreviewDocument}
        />
      </div>

      <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
        <h2 className="text-lg font-semibold text-white">My Access Requests</h2>
        <p className="mt-1 text-sm text-slate-400">Track patient approval of your normal document-access requests.</p>
        {myConsents.length > 0 ? (
          <div className="mt-5 space-y-3">
            {myConsents.slice(0, 6).map((consent) => (
              <div key={consent.id} className="rounded-md border border-white/10 bg-slate-950/50 p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold text-white">{consent.document.title}</p><span className="rounded-md bg-cyan-300/10 px-2 py-1 text-xs font-semibold text-cyan-100">{consent.status}</span></div>
                <p className="mt-2 text-slate-300">Patient: {consent.patient.name}</p><p className="mt-1 text-slate-400">Purpose: {consent.purpose}</p>
              </div>
            ))}
          </div>
        ) : <p className="mt-5 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-4 text-sm text-slate-400">No access requests yet.</p>}
      </div>

      <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
        <h2 className="text-lg font-semibold text-white">Clinical Context</h2>
        {selectedDocument ? (
          <div className="mt-5 space-y-4 text-sm">
            <div className="rounded-md border border-cyan-300/15 bg-cyan-300/[0.04] p-4">
              <div className="flex items-center gap-2 text-white">
                <FileSearch className="h-4 w-4 text-emerald-300" />
                <span className="font-semibold">{selectedDocument.title}</span>
              </div>
              <p className="mt-2 break-all text-slate-400">{selectedDocument.originalFileName}</p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-400">
                <span className="rounded-md bg-white/[0.05] px-2 py-1">{selectedDocument.mimeType}</span>
                <span className="inline-flex items-center gap-1 rounded-md bg-white/[0.05] px-2 py-1">
                  <Calendar className="h-3.5 w-3.5" />
                  Uploaded {formatDate(selectedDocument.createdAt)}
                </span>
              </div>
            </div>

            <div className="rounded-md bg-white/[0.03] p-4">
              <div className="flex items-center gap-2 text-slate-200">
                <UserRound className="h-4 w-4 text-cyan-300" />
                Patient
              </div>
              <p className="mt-3 font-semibold text-white">{selectedDocument.uploadedBy.name}</p>
              <p className="mt-1 flex items-center gap-2 text-slate-400">
                <Mail className="h-3.5 w-3.5" />
                {selectedDocument.uploadedBy.email}
              </p>
              <p className="mt-3 rounded-md border border-emerald-300/15 bg-emerald-300/10 px-3 py-2 text-xs leading-5 text-emerald-100">
                Access to this document was granted by the patient and is recorded in audit logs when opened.
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-5 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-6 text-sm leading-6 text-slate-400">
            Select a shared document to review patient context and record the access event.
          </div>
        )}
      </div>
      </DashboardShell>

      <DocumentPreviewModal
        document={previewDocument}
        isOpen={Boolean(previewDocument)}
        onClose={() => setPreviewDocument(null)}
      />

      <EmergencyAccessModal
        isOpen={isEmergencyDialogOpen}
        isGranting={isGrantingEmergencyAccess}
        error={emergencyError}
        onClose={() => setIsEmergencyDialogOpen(false)}
        onGrant={handleGrantEmergencyAccess}
      />

      <ConsentRequestModal
        isOpen={isConsentDialogOpen}
        isRequesting={isRequestingConsent}
        error={consentError}
        onClose={() => setIsConsentDialogOpen(false)}
        onRequest={handleRequestConsent}
      />
    </>
  );
}
