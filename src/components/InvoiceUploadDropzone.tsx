"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { unzip } from "fflate";

// Upload queue: every dropped file appears in a list with a live status —
// Waiting → Processing → Done / Split review / Rejected (with the reason).
// Files are processed one at a time so each shows real progress (the server
// ingests + extracts within the upload request, which can take 20-60s).
type QueueItem = {
  id: string;
  name: string;
  file: File;
  status: "queued" | "processing" | "done" | "split" | "error" | "extracting";
  message?: string;
  invoiceId?: string;
  pendingSplitId?: string;
};

// Kept in sync with ALLOWED_INVOICE_TYPES (src/lib/invoices.ts) — that
// file pulls in server-only modules (QBO, extraction) so it can't be
// imported directly into this client component; this is the client-side
// pre-check only, the server re-validates independently either way.
const ACCEPTED_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
];

// A .zip's contents arrive with no browser-assigned MIME type (each
// entry is raw bytes from fflate's unzip), so the type has to be
// inferred from the extension instead — same set as ACCEPTED_TYPES.
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const MAX_ZIP_BYTES = 50 * 1024 * 1024; // 50MB — the zip itself is only ever parsed in-browser, never uploaded whole; each extracted file still goes through the normal 20MB-per-file server check.

function isZipFile(file: File): boolean {
  return (
    file.type === "application/zip" ||
    file.type === "application/x-zip-compressed" ||
    file.name.toLowerCase().endsWith(".zip")
  );
}

// Unpacks a .zip into individual invoice files, skipping directory
// entries, macOS's __MACOSX/.DS_Store artifacts, and anything whose
// extension isn't one Flow can actually process. Async (not unzipSync)
// so a large archive doesn't block the main thread while parsing.
function extractZip(file: File): Promise<{ files: File[]; error?: string }> {
  return file
    .arrayBuffer()
    .then(
      (buf) =>
        new Promise<{ files: File[]; error?: string }>((resolve) => {
          unzip(new Uint8Array(buf), (err, entries) => {
            if (err) {
              resolve({ files: [], error: "Could not read this zip file." });
              return;
            }
            const files: File[] = [];
            for (const [path, bytes] of Object.entries(entries)) {
              if (path.endsWith("/")) continue;
              const name = path.split("/").pop() ?? path;
              if (!name || name.startsWith(".") || path.startsWith("__MACOSX/")) continue;
              const ext = name.toLowerCase().split(".").pop() ?? "";
              const mime = MIME_BY_EXTENSION[ext];
              if (!mime) continue;
              files.push(new File([bytes], name, { type: mime }));
            }
            resolve({
              files,
              error: files.length === 0 ? "No invoices found inside this zip." : undefined,
            });
          });
        })
    );
}

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
      if (res.status === 202) {
        // Accepted: extraction runs in the background now (see
        // ExtractionPoller). The file shows as Processing here and appears
        // in Recent uploads below once it's done.
        patchItem(item.id, {
          status: "processing",
          message: undefined,
        });
        return;
      }
      if (body.pendingSplitId) {
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

  // A zip is unpacked (extractZip, async) rather than queued directly —
  // its contained files re-enter this same function once extracted, so
  // a zip full of PDFs and a folder of dropped PDFs go through exactly
  // one code path from that point on. Everything else is queued as-is.
  function addFiles(files: File[]) {
    if (files.length === 0) return;

    const immediate: QueueItem[] = [];
    const zipFiles: File[] = [];

    for (const file of files) {
      if (isZipFile(file)) {
        if (file.size > MAX_ZIP_BYTES) {
          immediate.push({
            id: crypto.randomUUID(),
            name: file.name,
            file,
            status: "error",
            message: `Zip exceeds ${MAX_ZIP_BYTES / (1024 * 1024)}MB limit`,
          });
        } else {
          zipFiles.push(file);
        }
        continue;
      }
      const accepted = ACCEPTED_TYPES.includes(file.type);
      immediate.push({
        id: crypto.randomUUID(),
        name: file.name,
        file,
        status: accepted ? "queued" : "error",
        message: accepted
          ? undefined
          : "Not a supported file type (PDF, PNG, JPEG, WebP, Word, or Excel).",
      });
    }

    if (immediate.length > 0) {
      setQueue((prev) => [...prev, ...immediate]);
    }

    for (const zipFile of zipFiles) {
      const placeholderId = crypto.randomUUID();
      setQueue((prev) => [
        ...prev,
        { id: placeholderId, name: zipFile.name, file: zipFile, status: "extracting" },
      ]);
      extractZip(zipFile).then(({ files: extracted, error }) => {
        setQueue((prev) => prev.filter((it) => it.id !== placeholderId));
        if (error) {
          setQueue((prev) => [
            ...prev,
            { id: placeholderId, name: zipFile.name, file: zipFile, status: "error", message: error },
          ]);
          return;
        }
        addFiles(extracted);
      });
    }

    void runQueue();
  }

  // Paste a screenshot or a copied image straight in — window-level so it
  // works without first clicking into the dropzone, and harmless for any
  // other paste on this page: a normal text paste has no clipboard items
  // with kind "file", so this simply finds nothing and does nothing.
  useEffect(() => {
    function handlePaste(e: ClipboardEvent) {
      const clipboardItems = e.clipboardData?.items;
      if (!clipboardItems) return;
      const pasted: File[] = [];
      for (const item of clipboardItems) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) pasted.push(file);
      }
      if (pasted.length === 0) return;
      e.preventDefault();
      addFiles(pasted);
    }
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
    // addFiles/runQueue/setQueue all read and write itemsRef.current
    // directly rather than closing over the `items` state, so this
    // listener stays correct without re-binding on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishedCount = items.filter((it) =>
    ["done", "split", "error"].includes(it.status)
  ).length;
  const runningCount = items.filter((it) =>
    ["queued", "processing", "extracting"].includes(it.status)
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
          addFiles(Array.from(e.dataTransfer.files));
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
          PDF, PNG, JPEG, WebP, Word, Excel, or a zip of them — up to 20MB per file
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Copied an image? Paste it in (⌘V) — no need to save it first.
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="application/pdf,image/png,image/jpeg,image/webp,.docx,.xlsx,.zip,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/zip,application/x-zip-compressed"
          className="hidden"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>

      {items.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-elevation-1">
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
                  {it.status === "extracting" && (
                    <span className="flex items-center gap-1.5 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600">
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                      Unzipping…
                    </span>
                  )}
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
