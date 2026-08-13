import { Calendar, Eye, FileSearch, FileText, Image, Loader2, ShieldCheck, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import type { MedicalDocument } from '../../types/document';

interface DocumentListProps {
  documents: MedicalDocument[];
  isLoading: boolean;
  emptyMessage: string;
  emptyTitle?: string;
  selectedDocumentId?: string | null;
  highlightedDocumentId?: string | null;
  openingDocumentId?: string | null;
  onOpenDocument?: (documentId: string) => void;
  onPreviewDocument?: (document: MedicalDocument) => void;
  renderActions?: (document: MedicalDocument) => ReactNode;
}

const formatDate = (value: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));

const getFileLabel = (mimeType: MedicalDocument['mimeType']) => {
  if (mimeType === 'application/pdf') {
    return 'PDF';
  }

  return mimeType === 'image/png' ? 'PNG' : 'JPG';
};

const FileIcon = ({ mimeType }: { mimeType: MedicalDocument['mimeType'] }) =>
  mimeType === 'application/pdf' ? (
    <FileText className="h-5 w-5 text-rose-200" />
  ) : (
    <Image className="h-5 w-5 text-cyan-200" />
  );

export default function DocumentList({
  documents,
  isLoading,
  emptyMessage,
  emptyTitle = 'No documents yet',
  selectedDocumentId,
  highlightedDocumentId,
  openingDocumentId,
  onOpenDocument,
  onPreviewDocument,
  renderActions,
}: DocumentListProps) {
  if (isLoading) {
    return (
      <div className="mt-5 rounded-lg border border-white/10 bg-slate-950/60 p-5">
        <div className="flex items-center gap-2 text-sm text-slate-300">
          <Loader2 className="h-4 w-4 animate-spin text-emerald-300" />
          Loading documents...
        </div>
        <div className="mt-4 space-y-3">
          <div className="h-14 rounded-md bg-white/[0.03]" />
          <div className="h-14 rounded-md bg-white/[0.025]" />
        </div>
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="mt-5 rounded-lg border border-dashed border-white/15 bg-slate-950/60 p-8 text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-white/[0.04]">
          <FileText className="h-5 w-5 text-slate-300" />
        </span>
        <h3 className="mt-4 text-sm font-semibold text-white">{emptyTitle}</h3>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-400">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="mt-5 overflow-hidden rounded-md border border-white/10">
      <div className="divide-y divide-white/10">
        {documents.map((document) => (
          <div
            key={document.id}
            className={cn(
              'bg-slate-950/50 p-4 transition-colors',
              selectedDocumentId === document.id ? 'bg-emerald-300/[0.06]' : 'hover:bg-white/[0.025]',
              highlightedDocumentId === document.id ? 'ring-1 ring-inset ring-emerald-300/45' : ''
            )}
          >
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-white/5',
                      selectedDocumentId === document.id ? 'bg-emerald-300/10' : ''
                    )}
                  >
                    <FileIcon mimeType={document.mimeType} />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-white">{document.title}</h3>
                      {highlightedDocumentId === document.id ? (
                        <span className="rounded-md bg-emerald-300/10 px-2 py-0.5 text-xs font-semibold text-emerald-100">
                          New
                        </span>
                      ) : null}
                    </div>
                    <p className="truncate text-xs text-slate-400">{document.originalFileName}</p>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-400">
                  <span className="inline-flex items-center gap-1 rounded-md bg-white/[0.04] px-2 py-1">
                    <Calendar className="h-3.5 w-3.5" />
                    {formatDate(document.createdAt)}
                  </span>
                  <span className="rounded-md bg-white/[0.04] px-2 py-1">{getFileLabel(document.mimeType)}</span>
                  <span className="inline-flex items-center gap-1 rounded-md bg-white/[0.04] px-2 py-1">
                    <UserRound className="h-3.5 w-3.5" />
                    {document.uploadedBy.name}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md bg-white/[0.04] px-2 py-1">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {document.sharedWithDoctors.length} shared
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                {onPreviewDocument ? (
                  <Button type="button" size="sm" onClick={() => onPreviewDocument(document)}>
                    <Eye className="h-4 w-4" />
                    Preview
                  </Button>
                ) : null}
                {onOpenDocument ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => onOpenDocument(document.id)}
                    disabled={openingDocumentId === document.id}
                  >
                    {openingDocumentId === document.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <FileSearch className="h-4 w-4" />
                    )}
                    Details
                  </Button>
                ) : null}
                {renderActions ? renderActions(document) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
