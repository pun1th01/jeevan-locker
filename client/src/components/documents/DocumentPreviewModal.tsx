import * as Dialog from '@radix-ui/react-dialog';
import { AlertCircle, Download, FileText, Image, Loader2, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getApiErrorMessage } from '../../lib/api';
import { documentService } from '../../services/document.service';
import type { MedicalDocument } from '../../types/document';
import { Button } from '../ui/button';

interface DocumentPreviewModalProps {
  document: MedicalDocument | null;
  isOpen: boolean;
  onClose: () => void;
}

const getDocumentTypeLabel = (mimeType: MedicalDocument['mimeType']) => {
  if (mimeType === 'application/pdf') {
    return 'PDF';
  }

  return mimeType === 'image/png' ? 'PNG image' : 'JPG image';
};

export default function DocumentPreviewModal({ document, isOpen, onClose }: DocumentPreviewModalProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !document) {
      setPreviewUrl(null);
      setError(null);
      setDownloadError(null);
      return;
    }

    const controller = new AbortController();
    setIsLoading(true);
    setPreviewUrl(null);
    setError(null);
    setDownloadError(null);

    documentService
      .getDocumentPreviewBlob(document.id, controller.signal)
      .then((blob) => {
        if (!controller.signal.aborted) {
          setPreviewUrl(URL.createObjectURL(blob));
        }
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) {
          setError(getApiErrorMessage(requestError));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      });

    return () => controller.abort();
  }, [document, isOpen]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const handleDownload = async () => {
    if (!document) {
      return;
    }

    setIsDownloading(true);
    setDownloadError(null);

    try {
      await documentService.downloadDocumentFile(document);
    } catch (requestError) {
      setDownloadError(getApiErrorMessage(requestError));
    } finally {
      setIsDownloading(false);
    }
  };

  const isImage = document?.mimeType === 'image/jpeg' || document?.mimeType === 'image/png';
  const isPdf = document?.mimeType === 'application/pdf';

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[calc(100vw-2rem)] max-w-5xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-white/10 bg-slate-900 shadow-2xl shadow-cyan-950/30 outline-none data-[state=open]:animate-in data-[state=closed]:animate-out">
          <div className="flex flex-col gap-4 border-b border-white/10 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-white/[0.05]">
                  {isImage ? <Image className="h-4 w-4 text-cyan-200" /> : <FileText className="h-4 w-4 text-rose-200" />}
                </span>
                <div className="min-w-0">
                  <Dialog.Title className="truncate text-lg font-semibold text-white">
                    {document?.title ?? 'Document preview'}
                  </Dialog.Title>
                  <Dialog.Description className="truncate text-sm text-slate-400">
                    {document?.originalFileName ?? 'Secure authenticated preview'}
                  </Dialog.Description>
                </div>
              </div>
              {document ? (
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-400">
                  <span className="rounded-md bg-white/[0.04] px-2 py-1">{getDocumentTypeLabel(document.mimeType)}</span>
                  <span className="inline-flex items-center gap-1 rounded-md bg-emerald-300/10 px-2 py-1 text-emerald-100">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Access validated
                  </span>
                </div>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={handleDownload} disabled={!document || isDownloading}>
                {isDownloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Download
              </Button>
              <Dialog.Close asChild>
                <Button type="button" variant="ghost" size="icon" aria-label="Close preview">
                  <X className="h-4 w-4" />
                </Button>
              </Dialog.Close>
            </div>
          </div>

          <div className="min-h-[360px] flex-1 overflow-auto bg-slate-950/70 p-4">
            {isLoading ? (
              <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-white/10 bg-slate-900/60">
                <div className="text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-emerald-300" />
                  <p className="mt-3 text-sm font-medium text-white">Preparing secure preview...</p>
                  <p className="mt-1 text-xs text-slate-500">Validating access and loading the document.</p>
                </div>
              </div>
            ) : error ? (
              <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-rose-400/20 bg-rose-400/10 p-6 text-center">
                <div>
                  <AlertCircle className="mx-auto h-7 w-7 text-rose-200" />
                  <p className="mt-3 text-sm font-semibold text-rose-100">Preview unavailable</p>
                  <p className="mt-2 max-w-md text-sm leading-6 text-rose-100/80">{error}</p>
                </div>
              </div>
            ) : previewUrl && isImage ? (
              <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-white/10 bg-slate-900/60 p-3">
                <img
                  src={previewUrl}
                  alt={document?.title ?? 'Medical document preview'}
                  className="max-h-[68vh] max-w-full rounded-md object-contain"
                />
              </div>
            ) : previewUrl && isPdf ? (
              <iframe
                src={previewUrl}
                title={document?.title ?? 'Medical document PDF preview'}
                className="h-[68vh] min-h-[420px] w-full rounded-lg border border-white/10 bg-white"
              />
            ) : (
              <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-white/10 bg-slate-900/60 p-6 text-center">
                <div>
                  <FileText className="mx-auto h-7 w-7 text-slate-300" />
                  <p className="mt-3 text-sm font-semibold text-white">Preview not supported</p>
                  <p className="mt-2 max-w-md text-sm leading-6 text-slate-400">
                    This file type cannot be displayed in the browser. Use download to view it locally.
                  </p>
                </div>
              </div>
            )}

            {downloadError ? (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {downloadError}
              </div>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
