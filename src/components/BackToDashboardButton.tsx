import Link from "next/link";

// The one "leave this page" affordance every non-Dashboard page needs.
// Previously each page hand-rolled its own plain text-plus-arrow link with
// a slightly different className; this is the one shared, actual-looking
// button so it's consistent everywhere it appears. Authored by Araza.
export function BackToDashboardButton({ className = "" }: { className?: string }) {
  return (
    <Link
      href="/dashboard"
      className={`inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 shadow-elevation-1 transition-colors duration-150 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 ${className}`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
      Back to dashboard
    </Link>
  );
}
