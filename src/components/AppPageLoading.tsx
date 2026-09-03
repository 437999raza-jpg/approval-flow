import Image from "next/image";

export function AppPageLoading({
  title = "Opening page",
  description = "Loading the latest workspace data…",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      {/* The wordmark, not another grey bar. For the second a page takes,
          you should be looking at the product rather than at nothing. */}
      <Image
        src="/brand/ufirst-wordmark.png"
        alt="ufirst"
        width={2400}
        height={878}
        priority
        className="h-6 w-auto animate-pulse-soft"
      />
      <div className="mt-5 animate-pulse">
        <div className="h-8 w-64 rounded-lg bg-slate-200" />
        <div className="mt-3 h-4 w-96 max-w-full rounded-full bg-slate-100" />
      </div>

      <div className="mt-8 overflow-hidden rounded-xl border border-brand-line bg-white shadow-elevation-1">
        <div className="border-b border-brand-line px-5 py-4">
          <div className="text-sm font-semibold text-brand-ink">{title}</div>
          <p className="mt-1 text-sm text-brand-muted">{description}</p>
        </div>
        <div className="space-y-4 p-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="h-24 rounded-lg bg-slate-100" />
            <div className="h-24 rounded-lg bg-slate-100" />
            <div className="h-24 rounded-lg bg-slate-100" />
          </div>
          <div className="space-y-2">
            <div className="h-11 rounded-lg bg-slate-100" />
            <div className="h-11 rounded-lg bg-slate-100" />
            <div className="h-11 rounded-lg bg-slate-100" />
          </div>
        </div>
      </div>
    </main>
  );
}
