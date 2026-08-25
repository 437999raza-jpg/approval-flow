"use client";

// Renders an ISO timestamp in the VIEWER's local timezone. Server components
// format dates with the server's timezone (Vercel runs UTC), which made the
// Queue and other lists show UTC times; this formats on the client instead.
export function LocalTime({
  iso,
  dateOnly = false,
  withYear = false,
  className,
}: {
  iso: string;
  dateOnly?: boolean;
  withYear?: boolean;
  className?: string;
}) {
  const date = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = dateOnly
    ? { month: "short", day: "numeric", ...(withYear ? { year: "numeric" as const } : {}) }
    : {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        ...(withYear ? { year: "numeric" as const } : {}),
      };
  return (
    <span className={className} title={date.toLocaleString()}>
      {date.toLocaleString(undefined, opts)}
    </span>
  );
}
