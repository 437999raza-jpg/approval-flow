"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";

// Upload queue: every dropped file appears in a list with a live status —
// Waiting → Processing → Done / Split review / Rejected (with the reason).
// Files are processed one at a time so each shows real progress (the server
// ingests + extracts within the upload request, which can take 20-60s).
type QueueItem = {
  id: string;
  name: string;
  file: File;
  status: "queued" | "processing" | "done" | "split" | "error";
  message?: string;
  invoiceId?: string;
  pendingSplitId?: string;
};

const ACCEPTED_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
];

export function InvoiceUploadDropzone() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [items, setItems] = useState<QueueItem[]>([]);
  const itemsRef = useRef<QueueItem[]>([]);
  const runningRef = useRef(false);

  function setQueue(updater: (prev: QueueItem[]) => QueueItem[]) {
    itemsRef.current = updater(itemsRef.current);
    setItems(itemsRef.current);
  }

  function patchItem(id: string, patch: Partial<QueueItem>) {
    setQueue((prev) =>
      prev.map((it) => (it.id === id ? { ...it, ...patch } : it))
    );
  }

  async function processItem(item: QueueItem) {
    patchItem(item.id, { status: "processing" });
    try {
      const formData = new FormData();
      formData.append("file", item.file);

      const res = await fetch("/api/invoices/upload", {
        method: "POST",
        body: formData,
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        patchItem(item.id, {
          status: "error",
          message: body.error ?? `Upload failed (${res.status})`,
        });
        return;
      }
      if (res.status === 202 && body.pendingSplitId) {
        patchItem(item.id, {
          status: "split",
          pendingSplitId: body.pendingSplitId,
        });
        return;
      }
      patchItem(item.id, {
        status: "done",
        invoiceId: body.invoice?.id,
      });
      router.refresh();
    } catch (err) {
      patchItem(item.id, {
        status: "error",
        message: err instanceof Error ? err.message : "Upload failed",
      });
    }
  }

  // Process the queue one file at a time (Vercel Hobby runs one function at
  // a time anyway, and sequential gives each file a clear status).
  async function runQueue() {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      for (;;) {
        const next = itemsRef.current.find((it) => it.status === "queued");
        if (!next) break;
        await processItem(next);
      }
    } finally {
      runningRef.current = false;
    }
  }

  function addFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const fresh: QueueItem[] = Array.from(fileList).map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      file,
      status: ACCEPTED_TYPES.includes(file.type)
        ? ("queued" as const)
        : ("error" as const),
      message: ACCEPTED_TYPES.includes(file.type)
        ? undefined
        : "Not a PDF or image (use PDF, PNG, JPEG, or WebP).",
    }));
    setQueue((prev) => [...prev, ...fresh]);
    void runQueue();
  }

  const finishedCount = items.filter((it) =>
    ["done", "split", "error"].includes(it.status)
  ).length;
  const runningCount = items.filter((it) =>
    ["queued", "processing"].includes(it.status)
  ).length;

  function clearFinished() {
    setQueue((prev) =>
      prev.filter((it) => !["done", "split", "error"].includes(it.status))
    );
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        className={clsx(
          "flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 text-center transition-colors",
          isDragging ? "border-blue-500 bg-blue-50" : "border-slate-300 bg-white"
        )}
      >
        <p className="text-sm font-medium text-slate-700">
          {runningCount > 0
            ? `Processing ${runningCount} file${runningCount === 1 ? "" : "s"}…`
            : "Drop invoices here, or click to add one or more"}
        </p>
        <p className="mt-1 text-xs text-slate-400">
          PDF, PNG, JPEG, or WebP — up to 20MB each
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="application/pdf,image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {items.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Upload queue
            </span>
            {finishedCount > 0 && (
              <button
                type="button"
                onClick={clearFinished}
                className="text-xs text-slate-500 hover:underline"
              >
                Clear finished
              </button>
            )}
          </div>
          <ul className="divide-y divide-slate-100">
            {items.map((it) => (
              <li key={it.id} className="px-4 py-2.5">
                <div className="flex items-center gap-3 text-sm">
                  <span
                    className="min-w-0 flex-1 truncate text-slate-700"
                    title={it.name}
                  >
                    {it.name}
                  </span>
                  {it.status === "queued" && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                      Waiting…
                    </span>
                  )}
                  {it.status === "processing" && (
                    <span className="flex items-center gap-1.5 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600">
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                      Processing…
                    </span>
                  )}
                  {it.status === "done" && (
                    <>
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        Done
                      </span>
                      {it.invoiceId && (
                        <Link
                          href={`/dashboard/${it.invoiceId}`}
                          className="text-xs font-medium text-blue-600 hover:underline"
                        >
                          Open →
                        </Link>
                      )}
                    </>
                  )}
                  {it.status === "split" && (
                    <>
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                        Split review
                      </span>
                      {it.pendingSplitId && (
                        <Link
                          href={`/invoices/pending-splits/${it.pendingSplitId}`}
                          className="text-xs font-medium text-blue-600 hover:underline"
                        >
                          Review →
                        </Link>
                      )}
                    </>
                  )}
                  {it.status === "error" && (
                    <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">
                      Rejected
                    </span>
                  )}
                </div>
                {it.status === "error" && it.message && (
                  <p className="mt-1 text-xs text-rose-600">{it.message}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
