import { useLocation, useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/app';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import RulesTab from './RulesTab';
import HistoryTab from './HistoryTab';
import ContactsTab from './ContactsTab';

const TABS = [
  { value: 'rules', label: 'Rules', path: '/alerts' },
  { value: 'history', label: 'History', path: '/alerts/history' },
  { value: 'contacts', label: 'Where to send alerts', path: '/alerts/contacts' },
];

export default function Alerts() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const current = pathname.startsWith('/alerts/history')
    ? 'history'
    : pathname.startsWith('/alerts/contacts')
      ? 'contacts'
      : 'rules';
  return (
    <div className="page">
      <PageHeader
        title="Alerts"
        description="Tell us what to watch for and where to send the message. We only alert when something really needs you."
      />
      <Tabs
        value={current}
        onValueChange={(value) => navigate(TABS.find((t) => t.value === value).path)}
      >
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList aria-label="Alert sections">
            {TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="rules" className="mt-6 animate-in fade-in duration-200">
          <RulesTab />
        </TabsContent>
        <TabsContent value="history" className="mt-6 animate-in fade-in duration-200">
          <HistoryTab />
        </TabsContent>
        <TabsContent value="contacts" className="mt-6 animate-in fade-in duration-200">
          <ContactsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
