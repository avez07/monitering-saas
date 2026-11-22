import { useState } from 'react';
import { FormField } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { saveBillingProfile } from './billing-api';
import { useDo } from './api';

/** Who the invoices are made out to (owner only). GSTIN is optional. */
export default function BillingProfile({ profile }) {
  const [form, setForm] = useState({
    legalName: profile?.legalName || '',
    email: profile?.email || '',
    country: profile?.country || 'IN',
    state: profile?.state || '',
    gstin: profile?.gstin || '',
    address: profile?.address || '',
  });
  const save = useDo(saveBillingProfile, { success: 'Billing details saved.' });
  const bind = (key) => ({
    value: form[key],
    onChange: (e) => setForm({ ...form, [key]: e.target.value }),
  });

  return (
    <Card className="surface card-accent">
      <CardHeader>
        <CardTitle className="font-serif text-base">Billing details</CardTitle>
        <CardDescription>Shown on your invoices.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(form);
          }}
        >
          <FormField label="Company or legal name">
            {(p) => <Input {...p} maxLength={200} {...bind('legalName')} />}
          </FormField>
          <FormField label="Billing email">
            {(p) => <Input {...p} type="email" {...bind('email')} />}
          </FormField>
          <FormField label="Country code" hint="Two letters, for example IN or US.">
            {(p) => <Input {...p} maxLength={2} className="uppercase" {...bind('country')} />}
          </FormField>
          <FormField label="State code (India only)" hint="The 2-digit GST state code.">
            {(p) => <Input {...p} maxLength={2} inputMode="numeric" {...bind('state')} />}
          </FormField>
          <FormField label="GSTIN (optional)" hint="15 characters.">
            {(p) => <Input {...p} maxLength={15} className="uppercase" {...bind('gstin')} />}
          </FormField>
          <FormField label="Address" className="sm:col-span-2">
            {(p) => <Textarea {...p} rows={3} maxLength={500} {...bind('address')} />}
          </FormField>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={save.isPending}>
              Save billing details
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
