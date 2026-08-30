const { withSentryConfig } = require("@sentry/nextjs");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // mupdf is a WASM package; load it natively in server contexts instead of
  // letting webpack try to bundle the .wasm binary (which breaks it).
  experimental: {
    serverComponentsExternalPackages: ["mupdf"],
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
