import { BellRing, Globe, Server } from 'lucide-react';
import { Logo } from '@/components/shell/Logo';
import { ThemeToggle } from '@/components/shell/ThemeToggle';

const promises = [
  {
    icon: Server,
    title: 'See every server at a glance',
    text: 'CPU, memory and disk in plain language, updated every 30 seconds.',
  },
  {
    icon: Globe,
    title: 'Know when your website is down',
    text: 'We check it from outside, so we notice even when your own server cannot tell you.',
  },
  {
    icon: BellRing,
    title: 'Hear about problems first',
    text: 'An email reaches you before your customers notice.',
  },
];

/** Split signed-out layout: centered form on the left, brand panel on the right (desktop). */
export function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="grid min-h-dvh bg-background lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <main className="flex flex-col px-5 py-5 sm:px-10">
        <header className="flex items-center justify-between">
          <Logo />
          <ThemeToggle />
        </header>
        <div className="mx-auto flex w-full max-w-sm flex-1 animate-in fade-in slide-in-from-bottom-2 flex-col justify-center py-10 duration-200">
          <h1 className="font-serif text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>}
          <div className="surface card-accent mt-8 p-6">{children}</div>
        </div>
      </main>
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-primary/15 via-primary/10 to-accent px-14 py-12 lg:flex lg:flex-col lg:justify-center">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-primary/20 blur-3xl"
        />
        <div className="relative max-w-lg">
          <p className="text-xs font-medium uppercase tracking-wider text-primary">YuktiOps</p>
          <h2 className="mt-3 font-serif text-2xl font-semibold leading-tight tracking-tight">
            Simple monitoring for your servers and websites
          </h2>
          <p className="mt-2 text-base text-muted-foreground">Set up in about two minutes.</p>
          <ul className="mt-10 flex flex-col gap-6">
            {promises.map(({ icon: Icon, title: t, text }) => (
              <li key={t} className="flex items-start gap-3.5">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-card text-primary shadow-sm">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-medium">{t}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
