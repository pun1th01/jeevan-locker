import DashboardShell from '../../components/dashboard/DashboardShell';

const metrics = [
  { label: 'Assigned patients', value: '0', tone: 'text-cyan-300' },
  { label: 'Open requests', value: '0', tone: 'text-amber-300' },
  { label: 'Access status', value: 'Verified', tone: 'text-emerald-300' },
];

export default function DoctorDashboard() {
  return (
    <DashboardShell
      title="Doctor Dashboard"
      subtitle="Review assigned patients, manage authorized medical records, and keep care activity traceable."
      metrics={metrics}
    >
      <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
        <h2 className="text-lg font-semibold text-white">Patient Queue</h2>
        <div className="mt-5 rounded-md border border-dashed border-white/15 bg-slate-950/60 p-6 text-sm text-slate-400">
          No patients are assigned to this account yet.
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-slate-900/70 p-6">
        <h2 className="text-lg font-semibold text-white">Access Requests</h2>
        <div className="mt-5 space-y-3 text-sm text-slate-400">
          <div className="flex items-center justify-between rounded-md bg-white/[0.03] px-4 py-3">
            <span>Pending approvals</span>
            <span className="text-slate-200">0</span>
          </div>
          <div className="flex items-center justify-between rounded-md bg-white/[0.03] px-4 py-3">
            <span>Recent reviews</span>
            <span className="text-slate-200">0</span>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
