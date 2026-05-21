import DashboardShell from '../../components/dashboard/DashboardShell';

const metrics = [
  { label: 'Verified profile', value: 'Active', tone: 'text-emerald-300' },
  { label: 'Care access', value: '0', tone: 'text-cyan-300' },
  { label: 'Pending reviews', value: '0', tone: 'text-amber-300' },
];

export default function PatientDashboard() {
  return (
    <DashboardShell
      title="Patient Dashboard"
      subtitle="Your secure medical record workspace is ready for record intake, consent controls, and care coordination."
      metrics={metrics}
    >
      <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
        <h2 className="text-lg font-semibold text-white">Record Vault</h2>
        <div className="mt-5 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-6 text-sm text-slate-400">
          No medical records have been added yet.
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
        <h2 className="text-lg font-semibold text-white">Care Permissions</h2>
        <div className="mt-5 space-y-3 text-sm text-slate-400">
          <div className="flex items-center justify-between rounded-md bg-white/[0.03] px-4 py-3">
            <span>Doctor access</span>
            <span className="text-slate-200">None granted</span>
          </div>
          <div className="flex items-center justify-between rounded-md bg-white/[0.03] px-4 py-3">
            <span>Emergency access</span>
            <span className="text-emerald-200">Available</span>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
