import * as Dialog from '@radix-ui/react-dialog';
import { AlertCircle, Loader2, Send, X } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import type { ConsentTarget, RequestConsentInput } from '../../types/consent';
import { Button } from '../ui/button';
import { Label } from '../ui/label';

interface ConsentRequestModalProps {
  isOpen: boolean;
  isLoadingTargets: boolean;
  isRequesting: boolean;
  targets: ConsentTarget[];
  error: string | null;
  onClose: () => void;
  onRequest: (input: RequestConsentInput) => Promise<void>;
}

export default function ConsentRequestModal({
  isOpen,
  isLoadingTargets,
  isRequesting,
  targets,
  error,
  onClose,
  onRequest,
}: ConsentRequestModalProps) {
  const [selectedDocumentId, setSelectedDocumentId] = useState('');
  const [purpose, setPurpose] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const selectedTarget = useMemo(
    () => targets.find((target) => target.document.id === selectedDocumentId) ?? null,
    [selectedDocumentId, targets]
  );

  const closeModal = () => {
    if (isRequesting) return;
    setSelectedDocumentId('');
    setPurpose('');
    setValidationError(null);
    onClose();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedTarget) {
      setValidationError('Select a patient document before requesting access.');
      return;
    }
    if (!purpose.trim()) {
      setValidationError('A purpose for document access is required.');
      return;
    }
    setValidationError(null);
    await onRequest({ patientId: selectedTarget.patient.id, documentId: selectedTarget.document.id, purpose: purpose.trim() });
    closeModal();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => (!open ? closeModal() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-cyan-300/25 bg-slate-900 shadow-2xl shadow-cyan-950/30 outline-none sm:w-full">
          <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
            <div>
              <Dialog.Title className="text-lg font-semibold text-white">Request Document Access</Dialog.Title>
              <Dialog.Description className="mt-2 text-sm leading-6 text-slate-400">The patient must approve this request before you can access the document.</Dialog.Description>
            </div>
            <Dialog.Close asChild><Button type="button" variant="ghost" size="icon" disabled={isRequesting} aria-label="Close access request dialog"><X className="h-4 w-4" /></Button></Dialog.Close>
          </div>
          <form className="space-y-5 px-6 py-5" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="consent-document">Patient document</Label>
              {isLoadingTargets ? <div className="flex h-11 items-center gap-2 rounded-md border border-white/10 bg-slate-950/60 px-3 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading available records...</div> : (
                <select id="consent-document" value={selectedDocumentId} onChange={(event) => { setSelectedDocumentId(event.target.value); setValidationError(null); }} disabled={isRequesting || targets.length === 0} className="h-11 w-full rounded-md border border-white/10 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-cyan-300 focus:ring-2 focus:ring-cyan-300/20">
                  <option value="">Select patient and document</option>
                  {targets.map((target) => <option key={target.document.id} value={target.document.id}>{target.patient.name} — {target.document.title}</option>)}
                </select>
              )}
              {!isLoadingTargets && targets.length === 0 ? <p className="text-sm text-slate-500">No requestable documents are currently available.</p> : null}
            </div>
            {selectedTarget ? <div className="rounded-md border border-cyan-300/15 bg-cyan-300/[0.04] p-4 text-sm"><p className="font-semibold text-white">Patient: {selectedTarget.patient.name}</p><p className="mt-2 text-slate-300">Document: {selectedTarget.document.title}</p></div> : null}
            <div className="space-y-2">
              <Label htmlFor="consent-purpose">Purpose for access</Label>
              <textarea id="consent-purpose" value={purpose} onChange={(event) => { setPurpose(event.target.value); setValidationError(null); }} maxLength={500} disabled={isRequesting} placeholder="Review blood report for consultation." className="min-h-28 w-full resize-y rounded-md border border-white/10 bg-slate-950/70 px-3 py-3 text-sm text-slate-100 outline-none focus:border-cyan-300 focus:ring-2 focus:ring-cyan-300/20" />
              <p className="text-right text-xs text-slate-500">{purpose.length}/500</p>
            </div>
            {validationError || error ? <div className="flex items-start gap-2 rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-100"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{validationError ?? error}</div> : null}
            <div className="flex flex-col-reverse gap-3 border-t border-white/10 pt-5 sm:flex-row sm:justify-end"><Button type="button" variant="secondary" onClick={closeModal} disabled={isRequesting}>Cancel</Button><Button type="submit" disabled={isRequesting || isLoadingTargets || targets.length === 0}>{isRequesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{isRequesting ? 'Sending request...' : 'Request Access'}</Button></div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
