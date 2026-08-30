// Next.js's documented hook for runtime-specific startup code — loads the
// matching Sentry config for whichever runtime this instance is running
// (Node.js for normal server code, Edge for middleware.ts). Both configs
// are no-ops without NEXT_PUBLIC_SENTRY_DSN set — see sentry.*.config.ts.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

// Captures errors from nested React Server Components that otherwise
// wouldn't reach an error boundary. A safe no-op when Sentry was never
// initialized (no DSN configured).
export const onRequestError = Sentry.captureRequestError;
