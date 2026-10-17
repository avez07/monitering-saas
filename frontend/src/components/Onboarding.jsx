import { useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Terminal,
  Radio,
  Server,
  Boxes,
  Code2,
  ArrowRight,
} from 'lucide-react';
import { useAction, useWorkspace } from '../lib/workspace';
import { api, download } from '../lib/api';
import { Modal, Field, Select, Button, copy } from './ui';

export function Onboarding({ open, onOpenChange }) {
  const ws = useWorkspace(),
    action = useAction();
  const [projectId, setProjectId] = useState(''),
    [platform, setPlatform] = useState('local'),
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
    } catch {}
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
      title="Connect your infrastructure"
      description="A small agent. A clearer picture of your stack."
      wide
    >
      <div className="wizard-steps">
        {['Choose a source', 'Install & connect', 'Verify telemetry'].map((label, i) => (
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
          <span className="field-label">How would you like to connect?</span>
          <div className="source-grid">
            {[
              {
                id: 'local',
                icon: Server,
                name: 'Local host agent',
                hint: 'Windows, Linux & macOS',
              },
              {
                id: 'collector',
                icon: Boxes,
                name: 'OpenTelemetry',
                hint: 'Docker, systemd & Kubernetes',
              },
              {
                id: 'sdk',
                icon: Code2,
                name: 'Application SDK',
                hint: 'Node, Python, PHP, Java & .NET',
              },
            ].map(({ id, icon: Icon, name, hint }) => (
              <button
                key={id}
                className={`source-option ${platform === id ? 'selected' : ''}`}
                onClick={() => setPlatform(id)}
              >
                <Icon size={24} />
                <strong>{name}</strong>
                <span>{hint}</span>
                {platform === id && <Check className="source-check" size={15} />}
              </button>
            ))}
          </div>
          <div className="callout">
            <Radio size={17} />
            <p>
              {platform === 'local'
                ? 'The included Node.js agent reports CPU, memory, uptime, and filesystem utilization through outbound connections. No administrator access is required.'
                : 'Enroll a host to obtain a project-scoped agent credential, then use the supplied collector config or OTLP endpoint. Additional exporters require installation on your infrastructure.'}
            </p>
          </div>
          <div className="form-actions">
            <Button onClick={generate} loading={action.isPending} disabled={!selectedProject}>
              Generate installation token
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
              From the project root, inspect <code>backend/scripts/agent.mjs</code> and run the
              command below. It saves the agent credential to your local <code>.env</code>.
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
            One-time token · Expires in 15 minutes · No elevated permissions
          </p>
          <div className="endpoint-box">
            <span>OTLP/HTTP endpoint</span>
            <code>{ws.apiPublicUrl}/otlp</code>
          </div>
          {platform !== 'local' && (
            <p className="muted text-sm">
              After enrollment, open the agent’s menu to download its collector configuration. Put
              the credential from .env into PULSE_AGENT_TOKEN in the collector environment. SDK
              setup examples are in docs/AGENTS.md.
            </p>
          )}
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
            Agents send a heartbeat every 30 seconds. Open Agent management and look for your
            hostname with a recent heartbeat.
          </p>
          <div className="callout">
            <Check size={18} />
            <p>
              In demo mode, host measurements are saved to inventory. OTLP payloads are acknowledged
              and discarded. Switch to connected mode to store and explore live telemetry.
            </p>
          </div>
          <div className="form-actions">
            <Button
              onClick={() => {
                close(false);
                window.location.assign('/agents');
              }}
            >
              Open agent management
              <ArrowRight size={15} />
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
