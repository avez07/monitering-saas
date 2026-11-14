import { useState } from 'react';
import { Check, Copy, Terminal, Radio, ArrowRight, KeyRound } from 'lucide-react';
import { useAction, useApi, useWorkspace } from '../lib/workspace';
import { Modal, Field, Input, Button, copy } from './ui';

// Interim dialog: the guided "Add server" wizard replaces it in a later phase.
export function Onboarding({ open, onOpenChange }) {
  const ws = useWorkspace(),
    action = useAction();
  const status = useApi('/api-key', {}, { enabled: open && ws.canAdmin, retry: false });
  const [key, setKey] = useState(''),
    [fresh, setFresh] = useState(false),
    [confirming, setConfirming] = useState(false),
    [step, setStep] = useState(1);
  const existing = status.data?.key;
  const valid = /^yk_live_[a-f0-9]{64}$/.test(key.trim());
  const command = `node backend/scripts/agent.mjs --register --key ${key.trim()} --api ${ws.apiPublicUrl}`;
  async function issue(path) {
    try {
      const data = await action.mutateAsync({ path });
      setKey(data.key);
      setFresh(true);
      setStep(2);
    } catch {
      /* the error toast is shown by the shared mutation handler */
    }
  }
  function close(value) {
    onOpenChange(value);
    if (!value) {
      setKey('');
      setFresh(false);
      setConfirming(false);
      setStep(1);
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={close}
      title="Connect a server"
      description="A small agent that sends measurements out. Nothing needs to listen on your server."
      wide
    >
      <div className="wizard-steps">
        {['Get your API key', 'Install the agent', 'Check it is connected'].map((label, i) => (
          <div key={label} className={step >= i + 1 ? 'active' : ''}>
            <span>{step > i + 1 ? <Check size={13} /> : i + 1}</span>
            {label}
          </div>
        ))}
      </div>
      {step === 1 && (
        <div className="form-stack">
          <div className="callout">
            <KeyRound size={17} />
            <p>
              One account API key connects any number of servers. Each server then gets its own
              credential, so regenerating the key never disconnects servers that are already
              running.
            </p>
          </div>
          {!ws.canAdmin && (
            <p className="muted">
              Only an owner or administrator can create the API key. Ask one of them to connect a
              server.
            </p>
          )}
          {ws.canAdmin && status.isPending && <p className="muted">Checking your API key…</p>}
          {ws.canAdmin && status.isError && <p className="muted">{status.error.message}</p>}
          {ws.canAdmin && status.isSuccess && !existing && (
            <div className="form-actions">
              <Button onClick={() => issue('/api-key')} loading={action.isPending}>
                Create API key
                <ArrowRight size={15} />
              </Button>
            </div>
          )}
          {ws.canAdmin && existing && (
            <>
              <Field
                label={`Your API key (${existing.prefix}…)`}
                hint="For safety we only keep a fingerprint of it, so it cannot be shown again. Paste it here to build the command."
              >
                <Input
                  value={key}
                  placeholder="yk_live_…"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setKey(e.target.value)}
                />
              </Field>
              <div className="form-actions">
                {confirming ? (
                  <>
                    <span className="muted text-sm">
                      New installs will need the new key. Servers already connected keep running.
                    </span>
                    <Button variant="secondary" onClick={() => setConfirming(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => issue('/api-key/regenerate')}
                      loading={action.isPending}
                    >
                      Regenerate
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="secondary" onClick={() => setConfirming(true)}>
                      Lost it? Regenerate
                    </Button>
                    <Button onClick={() => setStep(2)} disabled={!valid}>
                      Continue
                      <ArrowRight size={15} />
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {step === 2 && (
        <div className="form-stack">
          <div className="callout">
            <Terminal size={18} />
            <p>
              Development build: from the project folder, run the command below in a terminal. The
              one-line installer for any Linux server arrives with the production agent.
            </p>
          </div>
          <div className="code-block">
            <div>
              <span>TERMINAL · NODE.JS 22+</span>
              <button aria-label="Copy install command" onClick={() => copy(command, ws.notify)}>
                <Copy size={15} />
              </button>
            </div>
            <pre>{command}</pre>
          </div>
          <p className="muted text-sm">
            {fresh
              ? 'This key is shown only now — copy it somewhere safe. '
              : 'Your key is not stored on this page. '}
            The server saves its own credential in your user config folder, never the account key.
          </p>
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button onClick={() => setStep(3)}>
              I’ve started the agent
              <ArrowRight size={15} />
            </Button>
          </div>
        </div>
      )}
      {step === 3 && (
        <div className="form-stack">
          <div className="verification-icon">
            <Radio size={32} />
          </div>
          <h3 className="text-center">Let’s make sure you’re connected.</h3>
          <p className="muted text-center">
            The agent reports every 30 seconds. Open the Servers page and look for your hostname.
          </p>
          <div className="form-actions">
            <Button
              onClick={() => {
                close(false);
                window.location.assign('/servers');
              }}
            >
              Open servers
              <ArrowRight size={15} />
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
