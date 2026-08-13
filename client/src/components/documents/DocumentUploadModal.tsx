import * as Dialog from '@radix-ui/react-dialog';
import {
  AlertCircle,
  CheckCircle2,
  FileCheck2,
  FileText,
  Image,
  Loader2,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '../../lib/utils';
import type { UploadDocumentInput } from '../../types/document';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

interface DocumentUploadModalProps {
  isOpen: boolean;
  isUploading: boolean;
  error: string | null;
  onClose: () => void;
  onResetError?: () => void;
  onUpload: (input: UploadDocumentInput, onProgress: (progress: number) => void) => Promise<void>;
}

interface ValidationState {
  title?: string;
  file?: string;
}

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const allowedMimeTypes = new Set(['application/pdf', 'image/jpeg', 'image/png']);

const formatFileSize = (bytes: number) => {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const getFileTypeLabel = (file: File) => {
  if (file.type === 'application/pdf') {
    return 'PDF';
  }

  return file.type === 'image/png' ? 'PNG' : 'JPG';
};

const getFileIcon = (file: File) =>
  file.type === 'application/pdf' ? (
    <FileText className="h-5 w-5 text-rose-200" />
  ) : (
    <Image className="h-5 w-5 text-cyan-200" />
  );

const validateFile = (file: File): string | null => {
  if (!allowedMimeTypes.has(file.type)) {
    return 'Only PDF, JPG, and PNG medical documents are supported.';
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `File size must be ${formatFileSize(MAX_FILE_SIZE_BYTES)} or less.`;
  }

  return null;
};

export default function DocumentUploadModal({
  isOpen,
  isUploading,
  error,
  onClose,
  onResetError,
  onUpload,
}: DocumentUploadModalProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [validation, setValidation] = useState<ValidationState>({});
  const [isDragActive, setIsDragActive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isSuccess, setIsSuccess] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setTitle('');
      setFile(null);
      setValidation({});
      setIsDragActive(false);
      setUploadProgress(0);
      setIsSuccess(false);
    }
  }, [isOpen]);

  const isReady = useMemo(() => Boolean(title.trim() && file && !validation.file), [file, title, validation.file]);

  const selectFile = (nextFile: File | null) => {
    if (!nextFile) {
      return;
    }

    onResetError?.();
    setFile(nextFile);
    setValidation((current) => ({ ...current, file: validateFile(nextFile) ?? undefined }));
  };

  const clearFile = () => {
    onResetError?.();
    setFile(null);
    setUploadProgress(0);
    setValidation((current) => ({ ...current, file: undefined }));

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    selectFile(event.target.files?.[0] ?? null);
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    selectFile(event.dataTransfer.files[0] ?? null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nextValidation: ValidationState = {};

    if (!title.trim()) {
      nextValidation.title = 'Add a short title before uploading.';
    }

    if (!file) {
      nextValidation.file = 'Choose or drop a PDF, JPG, or PNG file.';
    } else {
      const fileError = validateFile(file);

      if (fileError) {
        nextValidation.file = fileError;
      }
    }

    setValidation(nextValidation);

    if (Object.keys(nextValidation).length > 0 || !file) {
      return;
    }

    try {
      setUploadProgress(8);
      await onUpload({ title: title.trim(), file }, setUploadProgress);
      setUploadProgress(100);
      setIsSuccess(true);
      window.setTimeout(onClose, 650);
    } catch {
      setUploadProgress(0);
      setIsSuccess(false);
    }
  };

  const closeModal = () => {
    if (!isUploading) {
      onClose();
    }
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => (!open ? closeModal() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-white/10 bg-slate-900 p-0 shadow-2xl shadow-emerald-950/30 outline-none data-[state=open]:animate-in data-[state=closed]:animate-out sm:w-full">
          <div className="border-b border-white/10 px-6 py-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-lg font-semibold text-white">Upload medical document</Dialog.Title>
                <Dialog.Description className="mt-1 text-sm leading-6 text-slate-400">
                  Add one verified record to your vault. PDF, JPG, and PNG files up to 5 MB are supported.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={isUploading}
                  aria-label="Close upload form"
                >
                  <X className="h-4 w-4" />
                </Button>
              </Dialog.Close>
            </div>
          </div>

          <form className="space-y-5 px-6 py-5" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="document-title">Document title</Label>
                <span className="text-xs text-slate-500">Required</span>
              </div>
              <Input
                id="document-title"
                value={title}
                onChange={(event) => {
                  onResetError?.();
                  setTitle(event.target.value);
                  setValidation((current) => ({ ...current, title: undefined }));
                }}
                placeholder="Blood report, MRI scan, discharge summary"
                aria-invalid={Boolean(validation.title)}
                disabled={isUploading || isSuccess}
              />
              {validation.title ? <p className="text-sm text-amber-200">{validation.title}</p> : null}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label>Document file</Label>
                <span className="text-xs text-slate-500">PDF, JPG, PNG - max 5 MB</span>
              </div>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setIsDragActive(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragActive(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  setIsDragActive(false);
                }}
                onDrop={handleDrop}
                disabled={isUploading || isSuccess}
                className={cn(
                  'group flex w-full flex-col items-center justify-center rounded-lg border border-dashed px-5 py-8 text-center transition-all disabled:cursor-not-allowed disabled:opacity-70',
                  isDragActive
                    ? 'border-emerald-300 bg-emerald-300/10 shadow-lg shadow-emerald-950/30'
                    : 'border-white/15 bg-slate-950/50 hover:border-emerald-300/70 hover:bg-emerald-300/[0.04]',
                  validation.file ? 'border-amber-300/60 bg-amber-300/[0.04]' : ''
                )}
              >
                <span
                  className={cn(
                    'flex h-12 w-12 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] transition-colors',
                    isDragActive ? 'border-emerald-300/40 bg-emerald-300/10' : 'group-hover:bg-white/[0.07]'
                  )}
                >
                  <UploadCloud className="h-6 w-6 text-emerald-200" />
                </span>
                <span className="mt-4 text-sm font-semibold text-white">
                  {isDragActive ? 'Drop document here' : 'Drop file here or click to browse'}
                </span>
                <span className="mt-1 text-xs leading-5 text-slate-400">
                  Supported formats: PDF, JPG, PNG. Maximum file size: 5 MB.
                </span>
              </button>

              <input
                ref={fileInputRef}
                type="file"
                className="sr-only"
                accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                onChange={handleFileChange}
              />

              {validation.file ? (
                <div className="flex items-start gap-2 rounded-md border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-sm text-amber-100">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  {validation.file}
                </div>
              ) : null}
            </div>

            {file ? (
              <div className="rounded-lg border border-white/10 bg-slate-950/60 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-white/[0.05]">
                      {getFileIcon(file)}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-white">{file.name}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                        <span className="rounded-md bg-emerald-300/10 px-2 py-1 font-semibold text-emerald-100">
                          {getFileTypeLabel(file)}
                        </span>
                        <span>{formatFileSize(file.size)}</span>
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-md px-2 py-1',
                            isReady ? 'bg-emerald-300/10 text-emerald-100' : 'bg-white/[0.04] text-slate-400'
                          )}
                        >
                          <FileCheck2 className="h-3.5 w-3.5" />
                          {isReady ? 'Ready to upload' : 'Needs title'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearFile}
                    disabled={isUploading || isSuccess}
                  >
                    Replace
                  </Button>
                </div>
              </div>
            ) : null}

            {isUploading ? (
              <div className="rounded-md border border-emerald-300/20 bg-emerald-300/10 p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 font-medium text-emerald-100">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Uploading securely
                  </span>
                  <span className="text-xs text-emerald-100">{uploadProgress}%</span>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-950/60">
                  <div
                    className="h-full rounded-full bg-emerald-300 transition-all duration-300"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            ) : null}

            {isSuccess ? (
              <div className="flex items-start gap-2 rounded-md border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-sm text-emerald-100">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                Document uploaded and added to your vault.
              </div>
            ) : null}

            {error && !isUploading && !isSuccess ? (
              <div className="flex items-start gap-2 rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">Upload failed</p>
                  <p className="mt-0.5 text-rose-100/80">{error}</p>
                </div>
              </div>
            ) : null}

            <div className="flex flex-col-reverse gap-3 border-t border-white/10 pt-5 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" onClick={closeModal} disabled={isUploading}>
                Cancel
              </Button>
              <Button type="submit" disabled={!isReady || isUploading || isSuccess}>
                {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                {isUploading ? 'Uploading...' : 'Upload document'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
