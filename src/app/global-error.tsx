"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

// Next.js's documented last-resort error boundary — catches anything that
// escapes every route's own error.tsx, including errors in the root
// layout itself. Must render its own <html>/<body>; it fully replaces the
// root layout when triggered. Sentry.captureException is a safe no-op
// when no DSN is configured.
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-slate-50 px-4 font-sans text-slate-900">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="mt-2 text-sm text-slate-500">
            We&apos;ve been notified. Try reloading the page.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
