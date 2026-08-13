import * as Dialog from '@radix-ui/react-dialog';
import { AlertCircle, Loader2, Siren, X } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import type { EmergencyAccessTarget, GrantEmergencyAccessInput } from '../../types/emergencyAccess';
import { Button } from '../ui/button';
import { Label } from '../ui/label';

interface EmergencyAccessModalProps {
  isOpen: boolean;
  isLoadingTargets: boolean;
  isGranting: boolean;
  targets: EmergencyAccessTarget[];
  error: string | null;
  onClose: () => void;
  onGrant: (input: GrantEmergencyAccessInput) => Promise<void>;
}

export default function EmergencyAccessModal({
  isOpen,
  isLoadingTargets,
  isGranting,
  targets,
  error,
  onClose,
  onGrant,
}: EmergencyAccessModalProps) {
  const [selectedDocumentId, setSelectedDocumentId] = useState('');
  const [reason, setReason] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const selectedTarget = useMemo(
    () => targets.find((target) => target.document.id === selectedDocumentId) ?? null,
    [selectedDocumentId, targets]
  );

  const resetAndClose = () => {
    setSelectedDocumentId('');
    setReason('');
    setValidationError(null);
    onClose();
  };

  const closeModal = () => {
    if (!isGranting) {
      resetAndClose();
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!selectedTarget) {
      setValidationError('Select a patient document before granting emergency access.');
      return;
    }

    if (!reason.trim()) {
      setValidationError('An emergency access reason is required.');
      return;
    }

    setValidationError(null);
    await onGrant({
      patientId: selectedTarget.patient.id,
      documentId: selectedTarget.document.id,
      reason: reason.trim(),
    });
    resetAndClose();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => (!open ? closeModal() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-rose-300/25 bg-slate-900 shadow-2xl shadow-rose-950/30 outline-none sm:w-full">
          <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
            <div>
              <div className="flex items-center gap-2 text-rose-100">
                <span className="flex h-9 w-9 items-center justify-center rounded-md bg-rose-400/15">
                  <Siren className="h-4 w-4 text-rose-200" />
                </span>
                <Dialog.Title className="text-lg font-semibold">Emergency Access</Dialog.Title>
              </div>
              <Dialog.Description className="mt-3 text-sm leading-6 text-slate-400">
                Use Break-Glass only for an immediate clinical emergency. This action is audited.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon" disabled={isGranting} aria-label="Close emergency access dialog">
                <X className="h-4 w-4" />
              </Button>
            </Dialog.Close>
          </div>

          <form className="space-y-5 px-6 py-5" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="emergency-document">Patient document</Label>
              {isLoadingTargets ? (
                <div className="flex h-11 items-center gap-2 rounded-md border border-white/10 bg-slate-950/60 px-3 text-sm text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin text-rose-200" />
                  Loading available emergency records...
                </div>
              ) : (
                <select
                  id="emergency-document"
                  value={selectedDocumentId}
                  onChange={(event) => {
                    setSelectedDocumentId(event.target.value);
                    setValidationError(null);
                  }}
                  disabled={isGranting || targets.length === 0}
                  className="h-11 w-full rounded-md border border-white/10 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-rose-300 focus:ring-2 focus:ring-rose-300/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <option value="">Select patient and document</option>
                  {targets.map((target) => (
                    <option key={target.document.id} value={target.document.id}>
                      {target.patient.name} — {target.document.title}
                    </option>
                  ))}
                </select>
              )}
              {!isLoadingTargets && targets.length === 0 ? (
                <p className="text-sm text-slate-500">No emergency target documents are currently available.</p>
              ) : null}
            </div>

            {selectedTarget ? (
              <div className="rounded-md border border-rose-300/15 bg-rose-300/[0.04] p-4 text-sm">
                <p className="font-semibold text-white">Patient: {selectedTarget.patient.name}</p>
                <p className="mt-2 text-slate-300">Document: {selectedTarget.document.title}</p>
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="emergency-reason">Reason for emergency access</Label>
              <textarea
                id="emergency-reason"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  setValidationError(null);
                }}
                maxLength={500}
                disabled={isGranting}
                placeholder="Patient is unconscious and requires immediate treatment."
                className="min-h-28 w-full resize-y rounded-md border border-white/10 bg-slate-950/70 px-3 py-3 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-500 focus:border-rose-300 focus:ring-2 focus:ring-rose-300/20 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <p className="text-right text-xs text-slate-500">{reason.length}/500</p>
            </div>

            <div className="rounded-md border border-amber-300/20 bg-amber-300/10 px-3 py-3 text-sm leading-6 text-amber-100">
              Emergency access remains active for 15 minutes. The grant and every subsequent document access are logged.
            </div>

            {validationError || error ? (
              <div className="flex items-start gap-2 rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-100">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {validationError ?? error}
              </div>
            ) : null}

            <div className="flex flex-col-reverse gap-3 border-t border-white/10 pt-5 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" onClick={closeModal} disabled={isGranting}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={isGranting || isLoadingTargets || targets.length === 0}>
                {isGranting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Siren className="h-4 w-4" />}
                {isGranting ? 'Granting access...' : 'Grant Emergency Access'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
