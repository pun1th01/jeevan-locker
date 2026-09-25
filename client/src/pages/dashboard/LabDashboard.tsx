import { AlertCircle, CheckCircle2, FilePlus2, FlaskConical, Link2, Loader2, Plus, Trash2, Upload } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import DashboardShell from '../../components/dashboard/DashboardShell';
import DocumentList from '../../components/documents/DocumentList';
import DocumentPreviewModal from '../../components/documents/DocumentPreviewModal';
import PatientLookupField from '../../components/patients/PatientLookupField';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { getApiErrorMessage } from '../../lib/api';
import { labService } from '../../services/lab.service';
import { useAuthStore } from '../../store/useAuthStore';
import type { LabMedicalDocument } from '../../types/document';
import type { LabLink, LabReportTestValueInput } from '../../types/lab';

interface LabReportForm {
  title: string;
  labName: string;
  testName: string;
  nablCertNumber: string;
  authorizingDoctorName: string;
  hospitalName: string;
  reportDate: string;
}

interface TestValueRow {
  id: string;
  name: string;
  value: string;
  unit: string;
  refLow: string;
  refHigh: string;
  criticalLow: string;
  criticalHigh: string;
}

const initialReportForm: LabReportForm = {
  title: '',
  labName: '',
  testName: '',
  nablCertNumber: '',
  authorizingDoctorName: '',
  hospitalName: '',
  reportDate: '',
};

let testValueSequence = 0;

const createTestValueRow = (): TestValueRow => ({
  id: `test-value-${testValueSequence++}`,
  name: '',
  value: '',
  unit: '',
  refLow: '',
  refHigh: '',
  criticalLow: '',
  criticalHigh: '',
});

const statusClasses: Record<LabLink['status'], string> = {
  PENDING: 'border-amber-300/25 bg-amber-300/10 text-amber-100',
  ACTIVE: 'border-emerald-300/25 bg-emerald-300/10 text-emerald-100',
  REJECTED: 'border-rose-300/25 bg-rose-300/10 text-rose-100',
  REVOKED: 'border-slate-400/20 bg-slate-400/10 text-slate-300',
};

const formatDate = (value: string) =>
  new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));

const parseOptionalNumber = (value: string): number | undefined | null => {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return undefined;
  }

  const numericValue = Number(trimmedValue);
  return Number.isFinite(numericValue) ? numericValue : null;
};

export default function LabDashboard() {
  const user = useAuthStore((state) => state.user);
  const [links, setLinks] = useState<LabLink[]>([]);
  const [reports, setReports] = useState<LabMedicalDocument[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [selectedActiveLinkId, setSelectedActiveLinkId] = useState<string>('');
  const [form, setForm] = useState<LabReportForm>(initialReportForm);
  const [reportFile, setReportFile] = useState<File | null>(null);
  const [testValueRows, setTestValueRows] = useState<TestValueRow[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [previewDocument, setPreviewDocument] = useState<LabMedicalDocument | null>(null);

  const loadDashboardData = useCallback(async () => {
    setIsLoading(true);
    setPageError(null);

    try {
      const [nextLinks, nextReports] = await Promise.all([labService.getLinks(), labService.getIssuedReports()]);
      setLinks(nextLinks);
      setReports(nextReports);
    } catch (error) {
      setPageError(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboardData();
  }, [loadDashboardData]);

  const activeLinks = useMemo(() => links.filter((link) => link.status === 'ACTIVE'), [links]);
  const selectedActiveLink = useMemo(
    () => activeLinks.find((link) => link.id === selectedActiveLinkId) ?? activeLinks[0] ?? null,
    [activeLinks, selectedActiveLinkId]
  );

  const metrics = useMemo(
    () => [
      { label: 'Organisation', value: user?.organisation ?? '—', tone: 'text-emerald-300' },
      { label: 'Active links', value: String(activeLinks.length), tone: 'text-cyan-300' },
      { label: 'Reports issued', value: String(reports.length), tone: 'text-amber-300' },
    ],
    [activeLinks.length, reports.length, user?.organisation]
  );

  const handleLinkRequest = async (query: string) => {
    setPageError(null);
    const newLink = await labService.requestLink({ query });
    setLinks((currentLinks) => [newLink, ...currentLinks]);
    setSuccessMessage(`Link request sent to ${newLink.patient.name}.`);
  };

  const updateForm = (field: keyof LabReportForm, value: string) => {
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
  };

  const updateTestValue = (rowId: string, field: Exclude<keyof TestValueRow, 'id'>, value: string) => {
    setTestValueRows((currentRows) =>
      currentRows.map((row) => (row.id === rowId ? { ...row, [field]: value } : row))
    );
  };

  const buildTestValues = (): LabReportTestValueInput[] | null => {
    const testValues: LabReportTestValueInput[] = [];

    for (const [index, row] of testValueRows.entries()) {
      const label = `Test value ${index + 1}`;
      const numericValue = Number(row.value);
      const refLow = parseOptionalNumber(row.refLow);
      const refHigh = parseOptionalNumber(row.refHigh);
      const criticalLow = parseOptionalNumber(row.criticalLow);
      const criticalHigh = parseOptionalNumber(row.criticalHigh);

      if (!row.name.trim() || !row.unit.trim() || !row.value.trim() || !Number.isFinite(numericValue)) {
        setUploadError(`${label} needs a name, a finite numeric value, and a unit.`);
        return null;
      }

      if (refLow === null || refHigh === null || criticalLow === null || criticalHigh === null) {
        setUploadError(`${label} has an invalid range value.`);
        return null;
      }

      testValues.push({
        name: row.name.trim(),
        value: numericValue,
        unit: row.unit.trim(),
        ...(refLow === undefined ? {} : { refLow }),
        ...(refHigh === undefined ? {} : { refHigh }),
        ...(criticalLow === undefined ? {} : { criticalLow }),
        ...(criticalHigh === undefined ? {} : { criticalHigh }),
      });
    }

    return testValues;
  };

  const handleUpload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setUploadError(null);

    if (!selectedActiveLink) {
      setUploadError('Select a patient with an ACTIVE link before uploading a report.');
      return;
    }

    if (!reportFile) {
      setUploadError('Choose a PDF, JPG, or PNG report file.');
      return;
    }

    if (!form.title.trim()) {
      setUploadError('Enter a report title.');
      return;
    }

    let reportDate: string | undefined;
    if (form.reportDate) {
      const parsedDate = new Date(form.reportDate);
      if (Number.isNaN(parsedDate.getTime())) {
        setUploadError('Enter a valid report date.');
        return;
      }
      reportDate = parsedDate.toISOString();
    }

    const testValues = buildTestValues();
    if (!testValues) {
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);

    try {
      const uploadedReport = await labService.uploadReport(
        {
          patientId: selectedActiveLink.patient.id,
          file: reportFile,
          title: form.title,
          labName: form.labName,
          testName: form.testName,
          nablCertNumber: form.nablCertNumber,
          authorizingDoctorName: form.authorizingDoctorName,
          hospitalName: form.hospitalName,
          reportDate,
          testValues,
        },
        setUploadProgress
      );

      setReports((currentReports) => [uploadedReport, ...currentReports]);
      setForm(initialReportForm);
      setReportFile(null);
      setTestValueRows([]);
      setFileInputKey((currentKey) => currentKey + 1);
      setSuccessMessage(`${uploadedReport.title} was uploaded for ${selectedActiveLink.patient.name}.`);
    } catch (error) {
      setUploadError(getApiErrorMessage(error));
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  return (
    <>
      <DashboardShell
        title="Lab Dashboard"
        subtitle="Request patient authorisation, then issue verified reports to patients with an active LabLink."
        metrics={metrics}
      >
        <div className="space-y-4">
          {pageError ? (
            <div className="flex items-start gap-2 rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-100">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{pageError}</span>
            </div>
          ) : null}

          {successMessage ? (
            <div className="flex items-start gap-2 rounded-md border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-sm text-emerald-100">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{successMessage}</span>
            </div>
          ) : null}

          <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-emerald-300/10">
                <Link2 className="h-5 w-5 text-emerald-200" />
              </span>
              <div>
                <h2 className="text-lg font-semibold text-white">Request patient authorisation</h2>
                <p className="mt-1 text-sm leading-6 text-slate-400">
                  Submit an exact patient email address or ObjectId. The patient must approve the request before report upload.
                </p>
              </div>
            </div>
            <div className="mt-5">
              <PatientLookupField mode="lab-link" onLinkRequest={handleLinkRequest} />
            </div>
          </div>

          <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-cyan-300/10">
                <FlaskConical className="h-5 w-5 text-cyan-200" />
              </span>
              <div>
                <h2 className="text-lg font-semibold text-white">Patient links</h2>
                <p className="mt-1 text-sm text-slate-400">Only ACTIVE links can receive a new lab report.</p>
              </div>
            </div>

            {isLoading ? (
              <div className="mt-5 flex items-center gap-2 text-sm text-slate-300">
                <Loader2 className="h-4 w-4 animate-spin text-emerald-300" />
                Loading lab links...
              </div>
            ) : links.length === 0 ? (
              <p className="mt-5 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-4 text-sm text-slate-400">
                No patient links yet. Request an authorisation above to begin.
              </p>
            ) : (
              <div className="mt-5 space-y-3">
                {links.map((link) => (
                  <div
                    key={link.id}
                    className="flex flex-col gap-3 rounded-md border border-white/10 bg-slate-950/50 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <p className="font-semibold text-white">{link.patient.name}</p>
                      <p className="mt-1 text-xs text-slate-500">Requested {formatDate(link.requestedAt)}</p>
                    </div>
                    <span className={`w-fit rounded-md border px-2 py-1 text-xs font-semibold ${statusClasses[link.status]}`}>
                      {link.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-amber-300/10">
                <FilePlus2 className="h-5 w-5 text-amber-200" />
              </span>
              <div>
                <h2 className="text-lg font-semibold text-white">Upload verified report</h2>
                <p className="mt-1 text-sm text-slate-400">All report fields are submitted to the Lab API; test-value flags stay server-owned.</p>
              </div>
            </div>

            <form className="mt-5 space-y-5" onSubmit={(event) => void handleUpload(event)}>
              <div className="space-y-2">
                <Label htmlFor="lab-patient">Patient with ACTIVE link</Label>
                <select
                  id="lab-patient"
                  value={selectedActiveLink?.id ?? ''}
                  onChange={(event) => setSelectedActiveLinkId(event.target.value)}
                  disabled={activeLinks.length === 0 || isUploading}
                  className="h-10 w-full rounded-md border border-white/10 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition-colors focus:border-emerald-300 focus:ring-2 focus:ring-emerald-300/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {activeLinks.length === 0 ? <option value="">No ACTIVE patient links</option> : null}
                  {activeLinks.map((link) => (
                    <option key={link.id} value={link.id}>
                      {link.patient.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="lab-report-file">Report file</Label>
                  <Input
                    key={fileInputKey}
                    id="lab-report-file"
                    type="file"
                    accept="application/pdf,image/jpeg,image/png"
                    disabled={!selectedActiveLink || isUploading}
                    onChange={(event) => setReportFile(event.target.files?.[0] ?? null)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lab-report-title">Report title</Label>
                  <Input
                    id="lab-report-title"
                    value={form.title}
                    onChange={(event) => updateForm('title', event.target.value)}
                    disabled={!selectedActiveLink || isUploading}
                    maxLength={120}
                    placeholder="Complete blood count"
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="lab-name">Lab name</Label>
                  <Input id="lab-name" value={form.labName} onChange={(event) => updateForm('labName', event.target.value)} disabled={!selectedActiveLink || isUploading} maxLength={120} placeholder={user?.organisation ?? 'Issuing lab'} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lab-test-name">Test name</Label>
                  <Input id="lab-test-name" value={form.testName} onChange={(event) => updateForm('testName', event.target.value)} disabled={!selectedActiveLink || isUploading} maxLength={120} placeholder="CBC panel" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lab-nabl-cert">NABL certificate number</Label>
                  <Input id="lab-nabl-cert" value={form.nablCertNumber} onChange={(event) => updateForm('nablCertNumber', event.target.value)} disabled={!selectedActiveLink || isUploading} maxLength={120} placeholder="MC-1234" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lab-authorizing-doctor">Authorizing doctor</Label>
                  <Input id="lab-authorizing-doctor" value={form.authorizingDoctorName} onChange={(event) => updateForm('authorizingDoctorName', event.target.value)} disabled={!selectedActiveLink || isUploading} maxLength={120} placeholder="Dr. Asha Rao" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lab-hospital">Hospital name</Label>
                  <Input id="lab-hospital" value={form.hospitalName} onChange={(event) => updateForm('hospitalName', event.target.value)} disabled={!selectedActiveLink || isUploading} maxLength={120} placeholder="Demo General Hospital" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lab-report-date">Report date</Label>
                  <Input id="lab-report-date" type="datetime-local" value={form.reportDate} onChange={(event) => updateForm('reportDate', event.target.value)} disabled={!selectedActiveLink || isUploading} />
                </div>
              </div>

              <div className="rounded-md border border-white/10 bg-slate-950/40 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="font-semibold text-white">Structured test values</h3>
                    <p className="mt-1 text-sm text-slate-400">Reference and critical limits are optional. The server computes every result flag.</p>
                  </div>
                  <Button type="button" size="sm" variant="secondary" disabled={!selectedActiveLink || isUploading} onClick={() => setTestValueRows((rows) => [...rows, createTestValueRow()])}>
                    <Plus className="h-4 w-4" />
                    Add value
                  </Button>
                </div>

                {testValueRows.length > 0 ? (
                  <div className="mt-4 space-y-4">
                    {testValueRows.map((row, index) => (
                      <div key={row.id} className="rounded-md border border-white/10 bg-slate-900/70 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-semibold text-white">Test value {index + 1}</p>
                          <Button type="button" size="icon" variant="ghost" aria-label={`Remove test value ${index + 1}`} disabled={isUploading} onClick={() => setTestValueRows((rows) => rows.filter((currentRow) => currentRow.id !== row.id))}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                          {([
                            ['name', 'Name', 'Hemoglobin'],
                            ['value', 'Value', '14.1'],
                            ['unit', 'Unit', 'g/dL'],
                            ['refLow', 'Reference low', '12'],
                            ['refHigh', 'Reference high', '16'],
                            ['criticalLow', 'Critical low', '7'],
                            ['criticalHigh', 'Critical high', ''],
                          ] as const).map(([field, label, placeholder]) => (
                            <div key={field} className="space-y-1.5">
                              <Label htmlFor={`${row.id}-${field}`}>{label}</Label>
                              <Input
                                id={`${row.id}-${field}`}
                                type={field === 'name' || field === 'unit' ? 'text' : 'number'}
                                step="any"
                                value={row[field]}
                                onChange={(event) => updateTestValue(row.id, field, event.target.value)}
                                disabled={isUploading}
                                placeholder={placeholder}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-4 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-3 text-sm text-slate-400">
                    No structured test values added. Add rows when the report includes measurable results.
                  </p>
                )}
              </div>

              {uploadError ? (
                <div className="flex items-start gap-2 rounded-md border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-100">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{uploadError}</span>
                </div>
              ) : null}

              {isUploading ? <p className="text-sm text-slate-400">Uploading report... {uploadProgress}%</p> : null}

              <Button type="submit" disabled={!selectedActiveLink || isUploading}>
                {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {isUploading ? 'Uploading report' : 'Upload report'}
              </Button>
            </form>
          </div>
        </div>

        <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
          <h2 className="text-lg font-semibold text-white">Issued reports</h2>
          <p className="mt-1 text-sm text-slate-400">Reports issued by this lab remain readable after a patient revokes a link.</p>
          <DocumentList
            documents={reports}
            isLoading={isLoading}
            emptyTitle="No reports issued"
            emptyMessage="Reports uploaded through this workspace will appear here."
            onPreviewDocument={setPreviewDocument}
          />
        </div>
      </DashboardShell>

      <DocumentPreviewModal
        document={previewDocument}
        isOpen={Boolean(previewDocument)}
        onClose={() => setPreviewDocument(null)}
      />
    </>
  );
}
