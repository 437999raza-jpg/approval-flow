"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";

// Reorder AND delete pages inside an invoice's merged PDF — the in-app
// replacement for merging/reordering/trimming pages in Preview or another
// external tool. Each page has ↑/↓ to move it and ✕ to remove it; Apply
// rebuilds the PDF with only the kept pages (in the new order) and
// re-extracts the fields.
export function ReorderPagesModal({
  invoiceId,
  getPageCount,
  reorder,
}: {
  invoiceId: string;
  getPageCount: (invoiceId: string) => Promise<number | null>;
  reorder: (
    invoiceId: string,
    order: number[]
  ) => Promise<{ ok: boolean; error?: string; warning?: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [order, setOrder] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refreshPages() {
    const n = await getPageCount(invoiceId);
    setPageCount(n);
    if (n && n > 1) {
      setOrder(Array.from({ length: n }, (_, i) => i + 1));
    } else {
      setOrder([]);
    }
    return n;
  }

  async function openModal() {
    setOpen(true);
    setError(null);
    setWarning(null);
    setLoading(true);
    const n = await refreshPages();
    setLoading(false);
    if (!n || n <= 1) return;
  }

  function move(index: number, dir: -1 | 1) {
    setOrder((prev) => {
      const next = [...prev];
      const j = index + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  }

  function removePage(page: number) {
    setOrder((prev) => prev.filter((p) => p !== page));
  }

  async function apply() {
    setBusy(true);
    setError(null);
    setWarning(null);
    const res = await reorder(invoiceId, order);
    setBusy(false);
    if (!res.ok) {
      // The document may have changed (or storage lagged behind a previous
      // reorder) — reload the actual page count and reset the list so the
      // user works against the real document, then show the error.
      setError(res.error ?? "Could not reorder the pages.");
      void refreshPages();
      return;
    }
    if (res.warning) {
      setWarning(res.warning);
      void refreshPages(); // doc was rebuilt — sync the list to the new pages
      return; // keep the modal open so the warning is visible
    }
    setOpen(false);
    router.refresh();
  }

  const isOriginalOrder = pageCount
    ? order.length === pageCount &&
      order.every((p, i) => p === i + 1)
    : true;
  const nothingLeft = order.length === 0;

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="font-medium text-blue-600 hover:text-blue-700 hover:underline"
      >
        Reorder pages
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-8"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-lg bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <h2 className="text-sm font-semibold">Rearrange or delete pages</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="text-lg leading-none text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>

            <div className="p-5">
              {loading ? (
                <p className="text-sm text-slate-500">Reading the document…</p>
              ) : !pageCount || pageCount <= 1 ? (
                <p className="text-sm text-slate-500">
                  {pageCount === null
                    ? "This document isn't a PDF, so its pages can't be reordered."
                    : "This document has only one page — nothing to reorder."}
                </p>
              ) : (
                <>
                  <p className="mb-2 text-xs text-slate-500">
                    Move pages into the order you want, and use ✕ to remove
                    pages you don&apos;t need. The invoice should come first.
                  </p>
                  <ul className="space-y-1">
                    {order.map((page, i) => (
                      <li
                        key={page}
                        className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-1.5 text-sm"
                      >
                        <span className="w-8 text-slate-400">#{i + 1}</span>
                        <span className="flex-1 font-medium text-slate-700">
                          Page {page}
                        </span>
                        <button
                          type="button"
                          onClick={() => move(i, -1)}
                          disabled={i === 0}
                          className="rounded px-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                          title="Move up"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => move(i, 1)}
                          disabled={i === order.length - 1}
                          className="rounded px-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                          title="Move down"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => removePage(page)}
                          className="rounded px-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                          title="Delete this page"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                  {nothingLeft && (
                    <p className="mt-2 text-xs text-rose-600">
                      At least one page must remain.
                    </p>
                  )}
                  {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
                  {warning && <p className="mt-2 text-xs text-amber-700">{warning}</p>}
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setOpen(false)}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={apply}
                      disabled={isOriginalOrder || nothingLeft || busy}
                      className={clsx(
                        "rounded-md px-3 py-1.5 text-xs font-medium",
                        isOriginalOrder || nothingLeft || busy
                          ? "cursor-default bg-slate-100 text-slate-400"
                          : "bg-blue-600 text-white hover:bg-blue-700"
                      )}
                    >
                      {busy ? "Applying…" : "Apply changes"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
