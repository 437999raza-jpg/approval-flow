"use client";

import { useState } from "react";
import { clsx } from "clsx";
import { useToast } from "./ToastContext";

// Reject requires a reason — forced via this popup instead of the old bare
// one-click button. The reason posts to Discussion (see rejectWithReason in
// dashboard-actions.ts), not the accounting-notes thread, so the team sees
// WHY in the same place @mentions and other back-and-forth already lives.
export function RejectReasonModal({
  reject,
  invoiceLabel,
}: {
  reject: (formData: FormData) => Promise<void>;
  // For the floating confirmation toast once this closes — the invoice
  // can vanish from view the moment it's rejected, same reasoning as the
  // Approve toast.
  invoiceLabel?: string;
}) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-md border border-transparent bg-red-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-red-700"
      >
        Reject
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-8"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-lg bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <h2 className="text-sm font-semibold">Reject this invoice</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                disabled={busy}
                className="text-lg leading-none text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <form
              className="p-5"
              action={async (formData) => {
                setBusy(true);
                await reject(formData);
                setBusy(false);
                setOpen(false);
                setReason("");
                showToast(`${invoiceLabel ?? "Invoice"} rejected`);
              }}
            >
              <label className="block text-xs font-medium text-slate-600">
                Reason (posted to Discussion)
              </label>
              <textarea
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                autoFocus
                placeholder="Why is this being rejected?"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  disabled={busy}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!reason.trim() || busy}
                  className={clsx(
                    "rounded-md px-3 py-1.5 text-xs font-medium",
                    !reason.trim() || busy
                      ? "cursor-default bg-slate-100 text-slate-400"
                      : "bg-red-600 text-white hover:bg-red-700"
                  )}
                >
                  {busy ? "Rejecting…" : "Reject"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
