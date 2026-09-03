import Image from "next/image";

// The wordmark while a screen is loading, rather than a grey rectangle.
//
// ApprovalMax does this and it reads as deliberate: for the second or so
// a page takes, you are looking at the product rather than at nothing.
// The skeleton screens Flow already had covered the settings-group
// pages, but the Dashboard — the screen people actually sit and wait on
// — had none at all, so it showed a blank frame.
//
// Deliberately quiet: the mark breathes rather than spins. A spinner
// says "something might be wrong"; a slow pulse says "this is coming".
// And it holds the same mist ground the app uses, so the real page
// arrives as a fill-in rather than a flash of a different colour.
//
// Respects prefers-reduced-motion via the animate-pulse-soft utility in
// globals.css. Authored by Araza.
export function BrandLoading({
  label,
  full = false,
}: {
  // What is being loaded, in the app's own words. Omitted entirely
  // rather than filled with "Loading…", which tells nobody anything.
  label?: string;
  // Whole viewport, for the first paint of a route group. Otherwise it
  // sits inside whatever shell has already rendered.
  full?: boolean;
}) {
  return (
    <div
      className={`flex ${
        full ? "min-h-screen" : "min-h-[60vh]"
      } w-full flex-col items-center justify-center gap-4 bg-brand-mist px-6`}
    >
      <Image
        src="/brand/ufirst-wordmark.png"
        alt="ufirst"
        width={2400}
        height={878}
        priority
        className="h-7 w-auto animate-pulse-soft"
      />
      {label && (
        <p className="text-sm text-brand-muted" role="status" aria-live="polite">
          {label}
        </p>
      )}
    </div>
  );
}
