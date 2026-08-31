"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Phase 2: client-side caching, used both by the (app) route group's
// layout (Settings, Billing, etc.) and directly by the Dashboard route
// (DashboardClient). One QueryClient per browser tab, created once via
// useState so it survives client-side navigations but resets on a real
// page reload — matching how the rest of the app already treats a full
// reload as "start fresh."
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Semi-static org/billing data — a minute of staleness is
            // fine, and mutations explicitly invalidate their own keys
            // anyway (see the useXMutation hooks), so this is just the
            // fallback for idle revisits.
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
