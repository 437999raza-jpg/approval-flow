// Loaded via instrumentation.ts's register() for the Edge runtime
// (middleware.ts runs here). A no-op with no DSN configured — see
// sentry.client.config.ts.
import * as Sentry from "@sentry/nextjs";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
  });
}
