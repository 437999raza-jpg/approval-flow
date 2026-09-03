"use client";

import { useFormStatus } from "react-dom";

// SubmitButton's small spinner is enough for a click that resolves in a
// beat, but a real multi-second wait (pushing a bill's line items,
// attachments and audit PDF to QuickBooks) reads as "did this hang?"
// without something more insistent — the same reason ApprovalMax shows a
// moving bar rather than just dimming a button. Reuses useFormStatus, so
// it must sit inside the same <form> as the action it's reporting on.
export function FormPendingBar({ label }: { label: string }) {
  const { pending } = useFormStatus();
  if (!pending) return null;
  return (
    <div className="mt-2 space-y-1.5" role="status" aria-live="polite">
      <p className="text-xs font-medium text-brand-muted">{label}</p>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-brand-mist">
        <div className="h-full w-1/3 animate-progress-indeterminate rounded-full bg-brand-green" />
      </div>
    </div>
  );
}
