// Loaded automatically by @sentry/nextjs's webpack plugin (see
// withSentryConfig in next.config.js) — no import needed elsewhere.
// A no-op with no DSN configured: nothing here changes app behavior until
// you create a Sentry account and set NEXT_PUBLIC_SENTRY_DSN.
import * as Sentry from "@sentry/nextjs";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
  });
}
