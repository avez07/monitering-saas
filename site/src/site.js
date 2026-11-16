export const APP_URL = (import.meta.env.PUBLIC_APP_URL || 'https://app.yuktiops.com').replace(/\/$/, '');
export const SITE_URL = (import.meta.env.PUBLIC_SITE_URL || 'https://yuktiops.com').replace(/\/$/, '');
export const CONTACT_EMAIL = import.meta.env.PUBLIC_CONTACT_EMAIL || 'hello@yuktiops.com';
export const REGISTER_URL = `${APP_URL}/register`;
export const LOGIN_URL = `${APP_URL}/login`;

export const NAV = [
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/security', label: 'Security' },
  { href: '/docs', label: 'Docs' },
];

// From PLAN.md section 5. Confirm before launch.
export const PLANS = [
  { id: 'free', name: 'Free', usd: '$0', inr: '₹0', servers: '2', checks: '5 (every 5 min)', history: '7 days', contacts: 'Email, Telegram', team: '1', telemetry: '1 GB / 3 days', blurb: 'Try it on a side project.' },
  { id: 'starter', name: 'Starter', usd: '$9', inr: '₹599', servers: '3', checks: '25 (every minute)', history: '30 days', contacts: 'All', team: '3', telemetry: '10 GB / 7 days', blurb: 'For a small site or shop.' },
  { id: 'pro', name: 'Pro', usd: '$29', inr: '₹1,999', servers: '10', checks: '100 (every minute)', history: '90 days', contacts: 'All', team: '10', telemetry: '50 GB / 15 days', blurb: 'For a growing team.', featured: true },
  { id: 'business', name: 'Business', usd: '$99', inr: '₹6,999', servers: '40', checks: '500 (every 30 s)', history: '1 year', contacts: 'All', team: 'Unlimited', telemetry: '250 GB / 30 days', blurb: 'For many servers and clients.' },
];
export const DOC_GROUPS = ['Start here', 'Using YuktiOps', 'Troubleshooting', 'OpenTelemetry'];
