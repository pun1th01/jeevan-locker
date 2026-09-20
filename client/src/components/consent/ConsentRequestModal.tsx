import * as Dialog from '@radix-ui/react-dialog';
import { AlertCircle, Loader2, Send, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import type { RequestConsentInput } from '../../types/consent';
import type { PatientDocumentAccess, PatientDocumentSelection } from '../../types/patient';
import PatientLookupField from '../patients/PatientLookupField';
import { Button } from '../ui/button';
import { Label } from '../ui/label';

interface ConsentRequestModalProps {
  isOpen: boolean;
  isRequesting: boolean;
  error: string | null;
  onClose: () => void;
  onRequest: (input: RequestConsentInput) => Promise<void>;
}

/**
 * A consent request makes sense when there is no relationship yet, or when the doctor only holds a
 * temporary break-glass grant and wants lasting access. Shared / approved / pending would all 409 server-side.
 */
const CONSENT_SELECTABLE_STATUSES: readonly PatientDocumentAccess[] = ['none', 'emergency_active'];

export default function ConsentRequestModal({ isOpen, isRequesting, error, onClose, onRequest }: ConsentRequestModalProps) {
  const [selection, setSelection] = useState<PatientDocumentSelection | null>(null);
  const [purpose, setPurpose] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const closeModal = () => {
    if (isRequesting) return;
    setSelection(null);
    setPurpose('');
    setValidationError(null);
    onClose();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selection) {
      setValidationError('Look up a patient and select a document before requesting access.');
      return;
    }
    if (!purpose.trim()) {
      setValidationError('A purpose for document access is required.');
      return;
    }
    setValidationError(null);
    await onRequest({ patientId: selection.patient.id, documentId: selection.document.id, purpose: purpose.trim() });
    closeModal();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => (!open ? closeModal() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-cyan-300/25 bg-slate-900 shadow-2xl shadow-cyan-950/30 outline-none sm:w-full">
          <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
            <div>
              <Dialog.Title className="text-lg font-semibold text-white">Request Document Access</Dialog.Title>
              <Dialog.Description className="mt-2 text-sm leading-6 text-slate-400">
                Look up the patient, choose a document, and explain why you need it. The patient must approve before you can open it.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon" disabled={isRequesting} aria-label="Close access request dialog">
                <X className="h-4 w-4" />
              </Button>
            </Dialog.Close>
          </div>
          <form className="flex-1 space-y-5 overflow-y-auto px-6 py-5" onSubmit={handleSubmit}>
            <PatientLookupField
              selectableStatuses={CONSENT_SELECTABLE_STATUSES}
              accent="cyan"
              disabled={isRequesting}
              onSelectionChange={(nextSelection) => {
                setSelection(nextSelection);
                setValidationError(null);
              }}
            />

            {selection ? (
              <div className="rounded-md border border-cyan-300/15 bg-cyan-300/[0.04] p-4 text-sm">
                <p className="font-semibold text-white">Patient: {selection.patient.name}</p>
                <p className="mt-2 text-slate-300">Document: {selection.document.title}</p>
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="consent-purpose">Purpose for access</Label>
              <textarea
                id="consent-purpose"
                value={purpose}
                onChange={(event) => {
                  setPurpose(event.target.value);
                  setValidationError(null);
                }}
                maxLength={500}
                disabled={isRequesting}
                placeholder="Review blood report for consultation."
                className="min-h-28 w-full resize-y rounded-md border border-white/10 bg-slate-950/70 px-3 py-3 text-sm text-slate-100 outline-none focus:border-cyan-300 focus:ring-2 focus:ring-cyan-300/20"
              />
              <p className="text-right text-xs text-slate-500">{purpose.length}/500</p>
            </div>

            {validationError || error ? (
              <div className="flex items-start gap-2 rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-100">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {validationError ?? error}
              </div>
            ) : null}

            <div className="flex flex-col-reverse gap-3 border-t border-white/10 pt-5 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" onClick={closeModal} disabled={isRequesting}>
                Cancel
              </Button>
              <Button type="submit" disabled={isRequesting || !selection}>
                {isRequesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {isRequesting ? 'Sending request...' : 'Request Access'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
