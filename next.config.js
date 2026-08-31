const { withSentryConfig } = require("@sentry/nextjs");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // mupdf is a WASM package; load it natively in server contexts instead of
  // letting webpack try to bundle the .wasm binary (which breaks it).
  experimental: {
    serverComponentsExternalPackages: ["mupdf"],
    // Next's client Router Cache: how long a dynamically-rendered route
    // stays served from client memory (instant, no server round trip)
    // before the next visit re-fetches. Default is 30s — doubled here
    // rather than pushed much higher, since this applies app-wide,
    // including the Dashboard's invoice views: a teammate's approval
    // decision in another session should still show up within about a
    // minute, not sit stale for 5-15 minutes just because Settings/
    // Billing would benefit from a longer window. Any Server Action that
    // calls revalidatePath/revalidateTag (every mutation already does)
    // busts this immediately for the acting user regardless of this
    // number — it only governs untouched, idle revisits.
    staleTimes: {
      dynamic: 60,
    },
  },
};

// Wraps the config for source-map upload at build time (needs
// SENTRY_AUTH_TOKEN/SENTRY_ORG/SENTRY_PROJECT — build succeeds without
// them too, it just skips the upload step) and to instrument
// request/response handling. A no-op wrapper when Sentry was never
// configured — this doesn't require NEXT_PUBLIC_SENTRY_DSN to be set.
module.exports = withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  webpack: { treeshake: { removeDebugLogging: true } },
});
