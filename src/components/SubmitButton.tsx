"use client";

import { useFormStatus } from "react-dom";
import type { ButtonHTMLAttributes } from "react";

// Every action in this app is a plain <form action={serverAction}> with a
// button in it — with no client-side state, a click gives no feedback at
// all until the page eventually re-renders, so it's unclear whether it
// registered (users end up clicking repeatedly). useFormStatus reports
// whether the nearest ANCESTOR <form> is submitting, so this only works
// as a normal descendant of the form it submits — not a button elsewhere
// on the page pointing at a form via the HTML `form="id"` attribute
// (those auto-save rows have no separate submit button to begin with).
// Dims + disables + shows a small spinner while pending; the label itself
// doesn't change, so no per-button custom copy is needed.
export function SubmitButton({
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className={`${className ?? ""} ${pending ? "opacity-60" : ""}`.trim()}
      {...rest}
    >
      {pending && (
        <svg
          className="mr-1.5 inline-block h-3 w-3 animate-spin align-[-2px]"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
      )}
      {children}
    </button>
  );
}
