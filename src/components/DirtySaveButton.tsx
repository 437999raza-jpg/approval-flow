"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { clsx } from "clsx";

// A Save button that greys out to "Saved" until something in its form
// actually changes, then comes alive.
//
// Why this exists: the workflow step rows had a Save button that looked
// identical whether or not there was unsaved typing, so filling in the
// step deadlines and moving down the rows silently discarded them — the
// settings looked set, and weren't. Every other inline control in the app
// (roles, substitutes, default tax rate) already reflects dirty state;
// this brings the same feedback to any plain server-action form.
//
// Deliberately generic rather than tied to specific fields: it snapshots
// the whole enclosing form and compares, so adding a field to that form
// later can't quietly leave the dirty check behind.
export function DirtySaveButton({
  className = "",
  saveLabel = "Save",
  savedLabel = "Saved",
  savingLabel = "Saving…",
}: {
  className?: string;
  saveLabel?: string;
  savedLabel?: string;
  savingLabel?: string;
}) {
  const { pending } = useFormStatus();
  const ref = useRef<HTMLButtonElement>(null);
  const baseline = useRef("");
  const wasPending = useRef(false);
  const [dirty, setDirty] = useState(false);

  const snapshot = (form: HTMLFormElement) =>
    new URLSearchParams(
      [...new FormData(form).entries()].map(([k, v]) => [k, String(v)])
    ).toString();

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    baseline.current = snapshot(form);
    const onChange = () => setDirty(snapshot(form) !== baseline.current);
    // "input" catches typing; "change" catches selects and date pickers.
    form.addEventListener("input", onChange);
    form.addEventListener("change", onChange);
    return () => {
      form.removeEventListener("input", onChange);
      form.removeEventListener("change", onChange);
    };
  }, []);

  // Once a submit finishes, whatever was just sent becomes the new
  // baseline — otherwise the button would stay lit after a successful
  // save and there'd be no way to tell saved from unsaved again.
  useEffect(() => {
    if (wasPending.current && !pending) {
      const form = ref.current?.form;
      if (form) baseline.current = snapshot(form);
      setDirty(false);
    }
    wasPending.current = pending;
  }, [pending]);

  return (
    <button
      ref={ref}
      type="submit"
      disabled={!dirty || pending}
      className={clsx(
        "rounded-md px-2 py-1 text-xs font-medium transition-colors",
        dirty && !pending
          ? "bg-brand-green text-white hover:bg-brand-green-dark"
          : "cursor-default bg-slate-100 text-slate-400",
        className
      )}
    >
      {pending ? savingLabel : dirty ? saveLabel : savedLabel}
    </button>
  );
}
