import React, { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, useRoutes } from 'react-router-dom';
import { queryClient } from '@/lib/query-client';
import { ThemeProvider } from '@/lib/theme';
import { SessionProvider } from '@/lib/session';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { LoadingState } from '@/components/app/states';
import { routes } from '@/routes';
import './index.css';

function AppRoutes() {
  return <Suspense fallback={<LoadingState fullScreen />}>{useRoutes(routes)}</Suspense>;
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <TooltipProvider delayDuration={200}>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
            <Toaster />
          </TooltipProvider>
        </SessionProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
