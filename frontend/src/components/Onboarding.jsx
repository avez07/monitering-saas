import { useState } from 'react';
import { Check, Copy, Terminal, Radio, ArrowRight } from 'lucide-react';
import { useAction, useWorkspace } from '../lib/workspace';
import { Modal, Field, Select, Button, copy } from './ui';

export function Onboarding({ open, onOpenChange }) {
  const ws = useWorkspace(),
    action = useAction();
  const [projectId, setProjectId] = useState(''),
    [result, setResult] = useState(null),
    [step, setStep] = useState(1);
  const selectedProject = projectId || ws.projects[0]?.id;
  async function generate() {
    try {
      const data = await action.mutateAsync({
        path: '/agents/enrollment-tokens',
        body: { projectId: selectedProject },
      });
      setResult(data);
      setStep(2);
    } catch {
      /* the error toast is shown by the shared mutation handler */
    }
  }
  function close(value) {
    onOpenChange(value);
    if (!value) {
      setResult(null);
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
        {['Choose a project', 'Install the agent', 'Check it is connected'].map((label, i) => (
          <div key={label} className={step >= i + 1 ? 'active' : ''}>
            <span>{step > i + 1 ? <Check size={13} /> : i + 1}</span>
            {label}
          </div>
        ))}
      </div>
      {step === 1 && (
        <div className="form-stack">
          <Field label="Project">
            <Select value={selectedProject || ''} onChange={(e) => setProjectId(e.target.value)}>
              {ws.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="callout">
            <Radio size={17} />
            <p>
              The agent reports CPU, memory, disk and uptime using outbound HTTPS only. It does not
              need administrator access.
            </p>
          </div>
          <div className="form-actions">
            <Button onClick={generate} loading={action.isPending} disabled={!selectedProject}>
              Generate install command
              <ArrowRight size={15} />
            </Button>
          </div>
        </div>
      )}
      {step === 2 && result && (
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
              <button
                aria-label="Copy install command"
                onClick={() => copy(result.command, ws.notify)}
              >
                <Copy size={15} />
              </button>
            </div>
            <pre>{result.command}</pre>
          </div>
          <p className="muted text-sm">
            One-time token · Expires in 15 minutes · The credential is saved in your user config
            folder, not in the project.
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
