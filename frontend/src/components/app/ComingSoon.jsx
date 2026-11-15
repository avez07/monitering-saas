import { Hammer } from 'lucide-react';
import { PageHeader } from './PageHeader';
import { EmptyState } from './states';

/** Placeholder used by page stubs until the real page exists. */
export function ComingSoon({ title, description }) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <EmptyState
        icon={Hammer}
        title="Coming soon"
        text="We are still building this page. Everything else keeps working in the meantime."
        action={{ label: 'Back to overview', to: '/' }}
      />
    </>
  );
}
