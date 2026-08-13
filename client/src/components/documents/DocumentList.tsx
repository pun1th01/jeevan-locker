import { Calendar, Eye, FileSearch, FileText, Image, Loader2, ShieldCheck, UserRound, Search, X } from 'lucide-react';
import { useState, useMemo } from 'react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
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
  const [searchQuery, setSearchQuery] = useState('');
  const [fileType, setFileType] = useState('All');
  const [sortOrder, setSortOrder] = useState('Newest');

  const filteredDocuments = useMemo(() => {
    let result = [...documents];

    if (fileType === 'PDF') {
      result = result.filter((d) => d.mimeType === 'application/pdf');
    } else if (fileType === 'Images') {
      result = result.filter((d) => ['image/png', 'image/jpeg', 'image/jpg'].includes(d.mimeType));
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter((d) => 
        d.title.toLowerCase().includes(query) || 
        d.originalFileName.toLowerCase().includes(query)
      );
    }

    result.sort((a, b) => {
      if (sortOrder === 'Newest') {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      if (sortOrder === 'Oldest') {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }
      if (sortOrder === 'Name A–Z') {
        return a.title.localeCompare(b.title);
      }
      if (sortOrder === 'Name Z–A') {
        return b.title.localeCompare(a.title);
      }
      return 0;
    });

    return result;
  }, [documents, searchQuery, fileType, sortOrder]);

  const hasActiveFilters = searchQuery !== '' || fileType !== 'All' || sortOrder !== 'Newest';

  const clearFilters = () => {
    setSearchQuery('');
    setFileType('All');
    setSortOrder('Newest');
  };

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
    <div className="space-y-4 mt-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <Input 
            placeholder="Search documents..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-10"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-400">Type:</span>
            <select
              value={fileType}
              onChange={(e) => setFileType(e.target.value)}
              className="h-10 rounded-md border border-white/10 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-emerald-300 focus:ring-2 focus:ring-emerald-300/20"
            >
              <option value="All">All</option>
              <option value="PDF">PDF</option>
              <option value="Images">Images</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-400">Sort:</span>
            <select
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              className="h-10 rounded-md border border-white/10 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-emerald-300 focus:ring-2 focus:ring-emerald-300/20"
            >
              <option value="Newest">Newest ▼</option>
              <option value="Oldest">Oldest ▲</option>
              <option value="Name A–Z">Name A–Z</option>
              <option value="Name Z–A">Name Z–A</option>
            </select>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between text-sm text-slate-400">
        <span>
          {filteredDocuments.length} {filteredDocuments.length === 1 ? 'document' : 'documents'} 
          {hasActiveFilters && searchQuery ? ' found' : ''}
        </span>
        {hasActiveFilters && (
          <button 
            type="button" 
            onClick={clearFilters}
            className="flex items-center gap-1 text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            <X className="h-3 w-3" />
            Clear filters
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-md border border-white/10">
        <div className="divide-y divide-white/10">
          {filteredDocuments.length > 0 ? (
            filteredDocuments.map((document) => (
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
        ))
      ) : (
        <div className="p-8 text-center bg-slate-950/60">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-white/[0.04]">
            <Search className="h-5 w-5 text-slate-300" />
          </span>
          <h3 className="mt-4 text-sm font-semibold text-white">No documents found</h3>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-400">
            {searchQuery ? 'Try a different search term or filter.' : 'No documents match the selected filter.'}
          </p>
        </div>
      )}
      </div>
    </div>
    </div>
  );
}
