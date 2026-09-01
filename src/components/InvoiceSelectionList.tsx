"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { InvoiceStatusBadge } from "./InvoiceStatusBadge";
import type { InvoiceStatus } from "@/lib/supabase/types";

// Multi-select invoice list: checkboxes on every row plus a batch action
// bar (delete / clear publishing data / export all PDFs as one file / send
// by email). Selection is purely client-side — nothing is stored or pushed
// into the URL; the actions are server actions bound by the page.
// Authored by Araza.

export interface SelectableInvoice {
  id: string;
  vendor: string; // vendor_name or file_name fallback
  amount: number | null;
  invoiceNumber: string | null;
  currency: string;
  status: InvoiceStatus;
  isDuplicate: boolean;
  holders: string[]; // approver display names for on_approval/on_hold
  selected: boolean; // is this the currently-open invoice?
  qboBillId: string | null; // set only once actually pushed to QBO (qbo_sync_status === "synced")
}

export function InvoiceSelectionList({
  rows,
  pinnedCount,
  qs,
  canReview,
  deleteInvoicesAction,
  clearQboPublishDataAction,
  emailInvoicesAction,
  onSelect,
  onRowIntent,
}: {
  rows: SelectableInvoice[];
  pinnedCount: number;
  qs: string;
  canReview: boolean;
  deleteInvoicesAction: (ids: string[]) => Promise<void>;
  clearQboPublishDataAction: (ids: string[]) => Promise<void>;
  emailInvoicesAction: (
    ids: string[],
    to: string,
    note: string
  ) => Promise<{ ok: boolean; error?: string }>;
  // Phase 2: when provided, a plain left-click selects the invoice via
  // client state (instant — no server round trip) instead of a real Next
  // navigation. The href stays real underneath, so modified clicks
  // (Cmd/Ctrl/middle-click — "open in new tab") still work normally via
  // the browser's own default handling, since preventDefault() is only
  // called for plain clicks.
  onSelect?: (id: string) => void;
  // Fired only when the user shows real intent toward a row (hover/focus),
  // not when scrolling happens to bring it into view. Full invoice-detail
  // reads are expensive, so scroll itself must stay cheap.
  onRowIntent?: (id: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState<null | "delete" | "clear" | "email">(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailNote, setEmailNote] = useState("");
  const [emailStatus, setEmailStatus] = useState<null | { ok: boolean; message: string }>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedCount = selected.size;
  const allIds = rows.map((r) => r.id);
  const allSelected = rows.length > 0 && allIds.every((id) => selected.has(id));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) allIds.forEach((id) => next.delete(id));
      else allIds.forEach((id) => next.add(id));
      return next;
    });
  };
  const clearSelection = () => {
    setSelected(new Set());
    setConfirmDelete(false);
    setConfirmClear(false);
    setEmailOpen(false);
    setEmailStatus(null);
  };

  // Two-step confirm: first click arms, second click runs. Auto-disarm
  // after 4s so a stray double-click can't nuke invoices.
  useEffect(() => {
    if (!confirmDelete && !confirmClear) return;
    confirmTimer.current = setTimeout(() => {
      setConfirmDelete(false);
      setConfirmClear(false);
    }, 4000);
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, [confirmDelete, confirmClear]);

  const runDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy("delete");
    try {
      await deleteInvoicesAction([...selected]);
      clearSelection();
    } finally {
      setBusy(null);
    }
  };

  const runClear = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setBusy("clear");
    try {
      await clearQboPublishDataAction([...selected]);
      clearSelection();
    } finally {
      setBusy(null);
    }
  };

  const exportPdf = () => {
    const url = `/api/invoices/batch-export?ids=${[...selected].join(",")}`;
    window.open(url, "_blank");
  };

  const runEmail = async () => {
    if (!emailTo.trim()) {
      setEmailStatus({ ok: false, message: "Enter a recipient email address." });
      return;
    }
    setBusy("email");
    setEmailStatus(null);
    try {
      const res = await emailInvoicesAction([...selected], emailTo, emailNote);
      setEmailStatus(
        res.ok
          ? { ok: true, message: "Email sent." }
          : { ok: false, message: res.error ?? "Email failed." }
      );
      if (res.ok) {
        setEmailOpen(false);
        setEmailTo("");
        setEmailNote("");
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      {/* Batch action bar — sticky at the top of the list while scrolling */}
      {selectedCount > 0 && canReview && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-slate-200 bg-slate-50 px-3 py-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-slate-600">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="h-3.5 w-3.5 rounded border-slate-300"
            />
            {selectedCount} selected
          </label>
          <button
            type="button"
            onClick={runDelete}
            disabled={busy !== null}
            className={clsx(
              "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              confirmDelete
                ? "border-red-600 bg-red-600 text-white"
                : "border-slate-300 text-slate-600 hover:border-red-400 hover:text-red-600"
            )}
          >
            {busy === "delete" ? "Deleting…" : confirmDelete ? "Click again to delete" : "Delete"}
          </button>
          <button
            type="button"
            onClick={runClear}
            disabled={busy !== null}
            className={clsx(
              "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              confirmClear
                ? "border-amber-500 bg-amber-500 text-white"
                : "border-slate-300 text-slate-600 hover:border-amber-400 hover:text-amber-600"
            )}
            title="Reset 'exported to QuickBooks' — approved invoices go back to QBO Ready"
          >
            {busy === "clear" ? "Resetting…" : confirmClear ? "Click again to reset" : "Clear publishing data"}
          </button>
          <button
            type="button"
            onClick={exportPdf}
            disabled={busy !== null}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-blue-400 hover:text-blue-600"
            title="Download all selected invoices' documents merged into one PDF"
          >
            Export PDFs (one file)
          </button>
          <button
            type="button"
            onClick={() => setEmailOpen((o) => !o)}
            disabled={busy !== null}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-blue-400 hover:text-blue-600"
          >
            Send by email
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="ml-auto text-xs text-slate-400 hover:text-slate-600"
          >
            Clear
          </button>
        </div>
      )}

      {/* Inline email form (expands under the bar) */}
      {emailOpen && selectedCount > 0 && (
        <div className="border-b border-slate-200 bg-blue-50/50 px-3 py-2">
          <div className="flex gap-2">
            <input
              type="email"
              value={emailTo}
              onChange={(e) => setEmailTo(e.target.value)}
              placeholder="recipient@example.com"
              className="w-56 rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={runEmail}
              disabled={busy === "email"}
              className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy === "email" ? "Sending…" : "Send"}
            </button>
            <button
              type="button"
              onClick={() => setEmailOpen(false)}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
          <input
            type="text"
            value={emailNote}
            onChange={(e) => setEmailNote(e.target.value)}
            placeholder="Optional note (attached as the email body)"
            className="mt-1.5 w-full rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
          />
          {emailStatus && (
            <p className={clsx("mt-1 text-xs", emailStatus.ok ? "text-emerald-700" : "text-rose-600")}>
              {emailStatus.message}
            </p>
          )}
        </div>
      )}

      {/* The rows */}
      {rows.length === 0 ? (
        <div className="p-8 text-center text-sm text-slate-500">
          No invoices in this view.
        </div>
      ) : (
        rows.map((inv, i) => (
          <div key={inv.id} className="[contain-intrinsic-size:76px] [content-visibility:auto]">
            {i === 0 && pinnedCount > 0 && (
              <div className="flex items-center gap-1.5 border-b border-orange-200 bg-orange-50 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-orange-800">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L14.71 3.86a2 2 0 0 0-3.42 0Z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Possible duplicates
              </div>
            )}
            {i === pinnedCount && pinnedCount > 0 && (
              <div className="border-b border-slate-200 bg-slate-50 px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                All invoices
              </div>
            )}
            <div className="flex items-stretch border-b border-slate-100">
              <label
                className={clsx(
                  "flex w-8 flex-none cursor-pointer items-center justify-center",
                  canReview ? "" : "hidden"
                )}
                title="Select for batch actions"
              >
                <input
                  type="checkbox"
                  checked={selected.has(inv.id)}
                  onChange={() => toggle(inv.id)}
                  className="h-3.5 w-3.5 rounded border-slate-300"
                />
              </label>
              <Link
                href={`/dashboard/${inv.id}${qs}`}
                aria-current={inv.selected ? "page" : undefined}
                scroll={false}
                onMouseEnter={() => onRowIntent?.(inv.id)}
                onFocus={() => onRowIntent?.(inv.id)}
                onClick={(e) => {
                  if (!onSelect) return;
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  e.preventDefault();
                  onSelect(inv.id);
                }}
                className={clsx(
                  "block min-w-0 flex-1 px-4 py-3",
                  inv.isDuplicate && "border-l-2 border-l-orange-300",
                  inv.selected ? "bg-brand-green/10" : "hover:bg-slate-50"
                )}
              >
                <div className="flex items-center gap-1.5">
                  <div className="min-w-0 flex-1 truncate text-sm font-medium">{inv.vendor}</div>
                  {inv.isDuplicate && (
                    <span className="inline-flex flex-none items-center rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-medium text-orange-800">
                      Duplicate
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs text-slate-500">
                      {inv.amount != null
                        ? inv.amount.toLocaleString(undefined, { style: "currency", currency: inv.currency })
                        : "No amount extracted"}
                    </div>
                    {/* A quick eyeball check against the source document —
                        the invoice number sitting right under the amount. */}
                    {inv.invoiceNumber && (
                      <div className="mt-0.5 truncate text-[11px] text-slate-400">
                        #{inv.invoiceNumber}
                      </div>
                    )}
                  </div>
                  {inv.qboBillId ? (
                    <span
                      role="link"
                      tabIndex={0}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        window.open(
                          `https://qbo.intuit.com/app/bill?txnId=${inv.qboBillId}`,
                          "_blank",
                          "noopener,noreferrer"
                        );
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        e.stopPropagation();
                        window.open(
                          `https://qbo.intuit.com/app/bill?txnId=${inv.qboBillId}`,
                          "_blank",
                          "noopener,noreferrer"
                        );
                      }}
                      title="Open this bill in QuickBooks Online"
                      className="inline-flex flex-none cursor-pointer items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 hover:bg-emerald-200"
                    >
                      Pushed to QBO ↗
                    </span>
                  ) : (
                    <InvoiceStatusBadge status={inv.status} />
                  )}
                </div>
                {inv.holders.length > 0 && (
                  <div className="mt-1 text-xs text-slate-400">
                    With {inv.holders.join(", ")}
                  </div>
                )}
              </Link>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
