import { AlertCircle, Calendar, Loader2, Search, Siren, UserRound } from 'lucide-react';
import { type KeyboardEvent, useId, useState } from 'react';
import { getApiErrorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { patientService } from '../../services/patient.service';
import type {
  PatientDocumentAccess,
  PatientDocumentSelection,
  PatientLookupDocument,
  PatientLookupResult,
} from '../../types/patient';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

interface DoctorPatientLookupFieldProps {
  /** Which `access` statuses the enclosing modal lets the doctor pick. Everything else renders disabled with its badge. */
  selectableStatuses: readonly PatientDocumentAccess[];
  /** Accent for the selected row / focus ring; matches the enclosing modal. */
  accent: 'cyan' | 'rose';
  disabled?: boolean;
  onSelectionChange: (selection: PatientDocumentSelection | null) => void;
  mode?: 'doctor';
}

interface LabLinkPatientLookupFieldProps {
  mode: 'lab-link';
  disabled?: boolean;
  onLinkRequest: (query: string) => Promise<void>;
}

type PatientLookupFieldProps = DoctorPatientLookupFieldProps | LabLinkPatientLookupFieldProps;

const accessBadgeLabels: Record<Exclude<PatientDocumentAccess, 'none'>, string> = {
  shared: 'Already shared',
  consent_approved: 'Access approved',
  consent_pending: 'Request pending',
  emergency_active: 'Emergency active',
};

const accentClasses = {
  cyan: {
    focus: 'focus:border-cyan-300 focus:ring-cyan-300/20',
    selected: 'border-cyan-300/40 bg-cyan-300/[0.06]',
  },
  rose: {
    focus: 'focus:border-rose-300 focus:ring-rose-300/20',
    selected: 'border-rose-300/40 bg-rose-300/[0.06]',
  },
  emerald: {
    focus: 'focus:border-emerald-300 focus:ring-emerald-300/20',
    selected: 'border-emerald-300/40 bg-emerald-300/[0.06]',
  },
} as const;

const formatDate = (value: string) =>
  new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));

const formatTime = (value: string) =>
  new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));

const emergencyBadgeLabel = (expiresAt: string | undefined) =>
  expiresAt ? `${accessBadgeLabels.emergency_active} until ${formatTime(expiresAt)}` : accessBadgeLabels.emergency_active;

interface Badge {
  key: string;
  label: string;
  emergency: boolean;
}

/**
 * One badge for `access` (unless 'none'), plus an independent emergency badge whenever a live grant exists
 * behind a higher-precedence status — so a doctor with a pending request AND an active grant sees both.
 */
const getBadges = (document: PatientLookupDocument): Badge[] => {
  const badges: Badge[] = [];

  if (document.access === 'emergency_active') {
    badges.push({ key: 'access', label: emergencyBadgeLabel(document.emergencyExpiresAt), emergency: true });
  } else if (document.access !== 'none') {
    badges.push({ key: 'access', label: accessBadgeLabels[document.access], emergency: false });
  }

  if (document.emergencyActive && document.access !== 'emergency_active') {
    badges.push({ key: 'emergency', label: emergencyBadgeLabel(document.emergencyExpiresAt), emergency: true });
  }

  return badges;
};

export default function PatientLookupField(props: PatientLookupFieldProps) {
  const { disabled = false } = props;
  const doctorProps: DoctorPatientLookupFieldProps | null = props.mode === 'lab-link' ? null : props;
  const accent = doctorProps?.accent ?? 'emerald';
  const inputId = useId();
  const [query, setQuery] = useState('');
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [result, setResult] = useState<PatientLookupResult | null>(null);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);

  const selectDocument = (document: PatientLookupDocument | null) => {
    if (!result || !doctorProps) {
      return;
    }

    setSelectedDocumentId(document?.id ?? null);
    doctorProps.onSelectionChange(document ? { patient: result.patient, document } : null);
  };

  const runLookup = async () => {
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      setLookupError('Enter the patient email address or ID.');
      return;
    }

    setIsLookingUp(true);
    setLookupError(null);
    setResult(null);
    setSelectedDocumentId(null);

    try {
      if (props.mode === 'lab-link') {
        await props.onLinkRequest(trimmedQuery);
        setQuery('');
        return;
      }

      props.onSelectionChange(null);
      setResult(await patientService.lookup(trimmedQuery));
    } catch (error) {
      setLookupError(getApiErrorMessage(error));
    } finally {
      setIsLookingUp(false);
    }
  };

  // Enter inside the lookup input must run the lookup, not submit the enclosing modal form.
  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runLookup();
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={inputId}>Patient email or ID</Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-500" />
            <Input
              id={inputId}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLookupError(null);
              }}
              onKeyDown={handleInputKeyDown}
              className={cn('pl-10', accentClasses[accent].focus)}
              placeholder="patient@example.com"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled || isLookingUp}
            />
          </div>
          <Button type="button" variant="secondary" onClick={() => void runLookup()} disabled={disabled || isLookingUp}>
            {isLookingUp ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {doctorProps ? 'Look up' : 'Request link'}
          </Button>
        </div>
        <p className="text-xs text-slate-500">
          Exact match only. Every {doctorProps ? 'lookup' : 'link request'} is recorded in the audit trail.
        </p>
      </div>

      {lookupError ? (
        <div className="flex items-start gap-2 rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-100">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {lookupError}
        </div>
      ) : null}

      {doctorProps && result ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-white">
            <UserRound className="h-4 w-4 text-slate-400" />
            <span className="font-semibold">{result.patient.name}</span>
            <span className="text-xs text-slate-500">
              {result.documents.length} {result.documents.length === 1 ? 'document' : 'documents'}
            </span>
          </div>

          {result.documents.length === 0 ? (
            <p className="rounded-md border border-dashed border-white/15 bg-slate-950/60 p-4 text-sm text-slate-400">
              This patient has no documents yet.
            </p>
          ) : (
            <div
              className="max-h-64 space-y-2 overflow-y-auto pr-1"
              role="radiogroup"
              aria-label={`Documents for ${result.patient.name}`}
            >
              {result.documents.map((document) => {
                const selectable = doctorProps.selectableStatuses.includes(document.access) && !disabled;
                const selected = selectedDocumentId === document.id;

                return (
                  <button
                    key={document.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={!selectable}
                    onClick={() => selectDocument(selected ? null : document)}
                    className={cn(
                      'flex w-full flex-col gap-2 rounded-md border px-3 py-3 text-left text-sm transition-colors',
                      selected ? accentClasses[accent].selected : 'border-white/10 bg-slate-950/50',
                      selectable ? 'hover:bg-white/[0.04]' : 'cursor-not-allowed opacity-70'
                    )}
                  >
                    <span className="font-medium text-white">{document.title}</span>
                    <span className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <span className="inline-flex items-center gap-1">
                        <Calendar className="h-3.5 w-3.5" />
                        {formatDate(document.createdAt)}
                      </span>
                      {getBadges(document).map((badge) => (
                        <span
                          key={badge.key}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold',
                            badge.emergency ? 'bg-rose-400/15 text-rose-100' : 'bg-white/[0.06] text-slate-300'
                          )}
                        >
                          {badge.emergency ? <Siren className="h-3 w-3" /> : null}
                          {badge.label}
                        </span>
                      ))}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
