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

/** Two-column signed-out layout: the form on the left, reasons to sign up on the right (desktop). */
export function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <main className="flex flex-col px-5 py-5 sm:px-10">
        <header className="flex items-center justify-between">
          <Logo />
          <ThemeToggle />
        </header>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-2 text-base text-muted-foreground">{subtitle}</p>}
          <div className="mt-8">{children}</div>
        </div>
      </main>
      <aside className="hidden border-l bg-muted/40 px-12 py-12 lg:flex lg:flex-col lg:justify-center">
        <h2 className="text-2xl font-semibold tracking-tight">
          Simple monitoring for your servers and websites
        </h2>
        <p className="mt-2 text-base text-muted-foreground">Set up in about two minutes.</p>
        <ul className="mt-8 flex flex-col gap-6">
          {promises.map(({ icon: Icon, title: t, text }) => (
            <li key={t} className="flex items-start gap-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <div>
                <p className="text-base font-medium">{t}</p>
                <p className="text-sm text-muted-foreground">{text}</p>
              </div>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
