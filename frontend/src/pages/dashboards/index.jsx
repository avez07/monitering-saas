import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { ChevronRight, LayoutGrid } from 'lucide-react';
import { EmptyState, ErrorState, PageHeader, TableSkeleton } from '@/components/app';
import { useSession } from '@/lib/session';
import { listOf, usePresets } from './api';
import DashboardView from './DashboardView';
import { LockedPreview } from './LockedPreview';

/** Preset list. Free and Starter see the locked preview instead. */
function PresetList() {
  const { plan } = useSession();
  const entitled = Boolean(plan?.features?.advancedDashboard);
  const presets = usePresets(entitled);
  const items = listOf(presets.data);
  const locked = !entitled || presets.error?.status === 402;
  return (
    <div className="page">
      <PageHeader
        title="Dashboards"
        description="Grafana-style dashboards built from the Prometheus metrics your Linux agents send."
      />
      {locked ? (
        <LockedPreview />
      ) : presets.isPending ? (
        <TableSkeleton rows={2} />
      ) : presets.error ? (
        <ErrorState title="We couldn't load dashboards" error={presets.error} onRetry={() => presets.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={LayoutGrid} title="No dashboards yet" text="Dashboards appear here once they are available for your plan." />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Dashboards">
          {items.map((p) => (
            <li key={p.id}>
              <Link
                to={`/dashboards/${p.id}`}
                className="surface card-accent group flex h-full items-start gap-4 p-5 transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <LayoutGrid className="size-5" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{p.title}</span>
                  {p.description && <span className="mt-1 block text-sm text-muted-foreground">{p.description}</span>}
                </span>
                <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DashboardPage() {
  const { presetId } = useParams();
  const { plan } = useSession();
  const presets = usePresets(Boolean(plan?.features?.advancedDashboard));
  const title = listOf(presets.data).find((p) => p.id === presetId)?.title || 'Dashboard';
  return (
    <div className="page">
      <PageHeader title={title} breadcrumbs={[{ label: 'Dashboards', to: '/dashboards' }, { label: title }]} />
      <DashboardView presetId={presetId} />
    </div>
  );
}

export default function Dashboards() {
  return (
    <Routes>
      <Route index element={<PresetList />} />
      <Route path=":presetId" element={<DashboardPage />} />
      <Route path="*" element={<Navigate to="/dashboards" replace />} />
    </Routes>
  );
}
