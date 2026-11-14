import { useState } from 'react';
import { Activity, ArrowRight, Server, Bell } from 'lucide-react';
import { api, session } from '../lib/api';
import { useApi } from '../lib/workspace';
import { Button, Field, Input } from '../components/ui';

export function AuthPage({ onSuccess }) {
  const [register, setRegister] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const settings = useApi('/auth/config');
  async function submit(event) {
    event?.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body =
        event?.currentTarget instanceof HTMLFormElement
          ? Object.fromEntries(new FormData(event.currentTarget))
          : undefined;
      // The server sets an httpOnly session cookie; nothing secret is kept in page storage.
      await api(register ? '/auth/register' : '/auth/login', { method: 'POST', body });
      session.org = null;
      onSuccess();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-story">
        <a href="/" className="brand">
          <span className="brand-icon">
            <Activity size={23} />
          </span>
          yukti<span className="brand-dot">ops</span>
        </a>
        <div className="auth-story-content">
          <span className="eyebrow">SIMPLE SERVER MONITORING</span>
          <h1>
            Know when your server
            <br />
            <em>needs you.</em>
          </h1>
          <p>Servers and websites, watched around the clock. Set up in under two minutes.</p>
          <div className="auth-feature">
            <Server size={20} />
            <span>CPU, memory, disk and uptime for every server.</span>
          </div>
          <div className="auth-feature">
            <Bell size={20} />
            <span>Alerts by email before your customers notice.</span>
          </div>
          <div className="auth-visual">
            <div className="auth-visual-top">
              <span>
                <i className="status-dot" /> All systems operational
              </span>
              <span>Live overview</span>
            </div>
            <svg viewBox="0 0 500 140">
              <defs>
                <linearGradient id="auth-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#9983ff" stopOpacity=".4" />
                  <stop offset="1" stopColor="#9983ff" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path
                d="M0 110 L20 100 40 103 60 80 80 85 100 65 120 78 140 40 160 53 180 45 200 66 220 54 240 70 260 40 280 45 300 30 320 50 340 35 360 48 380 22 400 32 420 12 440 30 460 20 480 32 500 13 V140 H0Z"
                fill="url(#auth-fill)"
              />
              <path
                d="M0 110 L20 100 40 103 60 80 80 85 100 65 120 78 140 40 160 53 180 45 200 66 220 54 240 70 260 40 280 45 300 30 320 50 340 35 360 48 380 22 400 32 420 12 440 30 460 20 480 32 500 13"
                fill="none"
                stroke="#ac98ff"
                strokeWidth="3"
              />
            </svg>
            <span className="auth-sample-label">Illustrative preview</span>
          </div>
        </div>
        <p className="auth-footer">Built for the way you ship.</p>
      </div>
      <div className="auth-form-wrap">
        <div className="auth-form">
          <div className="auth-mini-brand">
            <Activity /> yuktiops
          </div>
          <span className="eyebrow">YOUR MONITORING WORKSPACE</span>
          <h2>{register ? 'Make room for clarity.' : 'Welcome back.'}</h2>
          <p>
            {register
              ? 'Create your workspace. The free plan includes 2 servers.'
              : 'Sign in to see how your servers are doing.'}
          </p>
          <form onSubmit={submit}>
            {register && (
              <>
                <Field label="Your name">
                  <Input
                    name="name"
                    required
                    minLength={2}
                    placeholder="Alex Morgan"
                    autoComplete="name"
                  />
                </Field>
                <Field label="Organization">
                  <Input name="organization" required minLength={2} placeholder="Your company" />
                </Field>
              </>
            )}
            <Field label="Email address">
              <Input
                name="email"
                type="email"
                required
                placeholder="you@company.com"
                autoComplete="email"
              />
            </Field>
            <Field label="Password">
              <Input
                name="password"
                type="password"
                required
                minLength={register ? 10 : 1}
                placeholder={register ? 'At least 10 characters' : 'Enter your password'}
                autoComplete={register ? 'new-password' : 'current-password'}
              />
            </Field>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" loading={busy} className="w-full">
              {register ? 'Create workspace' : 'Sign in'}
              <ArrowRight size={16} />
            </Button>
          </form>
          <p className="auth-switch">
            {register ? 'Already have a workspace?' : 'New to YuktiOps?'}{' '}
            <button
              onClick={() => {
                setRegister(!register);
                setError('');
              }}
            >
              {register ? 'Sign in' : 'Create an account'}
            </button>
          </p>
          {settings.isError && (
            <p className="form-error">The backend is unavailable. Start it with npm run dev.</p>
          )}
        </div>
      </div>
    </div>
  );
}
