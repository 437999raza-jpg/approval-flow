// Single source of truth for building an absolute URL back into the app
// (used in emails, where a relative link makes no sense). Prefers the
// explicitly-configured production domain; falls back to Vercel's own
// auto-populated deployment URL (correct, if not pretty, for any
// deployment even if NEXT_PUBLIC_APP_URL was never set) rather than
// hardcoding localhost — a link that's ugly still works, one pointing at
// localhost never does for anyone but the developer's own machine.
export function getAppUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3210")
  );
}
