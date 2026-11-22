import { ChevronDown, KeyRound } from 'lucide-react';
import { CodeBlock, FormField } from '@/components/app';
import { Input } from '@/components/ui/input';
import { CREDENTIAL_KINDS, credentialSteps, credentialsRefError } from './credentials-guide';

/**
 * Optional "Credentials (for deep metrics)" part of the add and edit service dialogs.
 * Only a reference name is sent to YuktiOps; the instructions explain where the password goes on the host.
 */
export default function CredentialsSection({ kind, value, onChange }) {
  if (!CREDENTIAL_KINDS.includes(kind)) return null;
  const error = credentialsRefError(value);
  const steps = credentialSteps(kind, error ? '' : value);
  return (
    <fieldset className="space-y-3 rounded-xl border p-4">
      <legend className="px-1 text-sm font-medium">Credentials (optional, for deep metrics)</legend>
      <p className="text-sm text-muted-foreground">
        Without credentials we still check that the database answers. With them, the agent also
        reads its built-in statistics.
      </p>
      <FormField
        label="Credentials name"
        hint={`A name you choose, for example ${kind}-main. Leave empty to skip.`}
        error={error}
      >
        {(p) => (
          <Input
            {...p}
            value={value}
            maxLength={40}
            placeholder={`${kind}-main`}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => onChange(e.target.value.toLowerCase())}
          />
        )}
      </FormField>
      <details className="group surface p-3" data-testid="credentials-help">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium">
          <span className="flex items-center gap-2">
            <KeyRound className="size-4" aria-hidden="true" />
            The password stays on your server. How to set it up
          </span>
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="mt-3 space-y-4 text-sm">
          <p className="text-muted-foreground">
            YuktiOps only stores the name <code className="font-mono">{steps.ref}</code>. The agent reads
            the user and password on the host, so they are never sent to us. Replace PASS with a
            strong password.
          </p>
          <div className="space-y-2">
            <p className="font-medium">1. Create a read-only monitoring user</p>
            <p className="text-muted-foreground">{steps.grant.label}:</p>
            <CodeBlock code={steps.grant.code} label="command" />
            {steps.grant.note && <p className="text-muted-foreground">{steps.grant.note}</p>}
          </div>
          <div className="space-y-2">
            <p className="font-medium">2. Give the agent the password (pick one)</p>
            <p className="text-muted-foreground">
              Linux: a file only the agent can read. It must have mode 0600, or the agent refuses
              it and shows why.
            </p>
            <CodeBlock code={steps.file.linux} label="command" />
            <p className="text-muted-foreground">
              Windows: the same USER= and PASSWORD= lines in{' '}
              <code className="font-mono break-all">{steps.file.windows}</code>.
            </p>
            <p className="text-muted-foreground">
              Docker agent, or any host: environment variables on the agent (for example with -e in
              docker run or environment: in compose).
            </p>
            <CodeBlock code={steps.env} label="environment variables" />
          </div>
          <p className="text-muted-foreground">
            3. Within a minute the service shows &quot;authenticated&quot;, or the reason it could
            not sign in, such as &quot;auth failed: wrong user or password&quot; or &quot;credentials
            not found&quot;.
          </p>
        </div>
      </details>
    </fieldset>
  );
}
