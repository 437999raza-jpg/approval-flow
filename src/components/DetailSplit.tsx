"use client";

import { useRef, useState, type ReactNode } from "react";
import { BillPanel } from "./BillPanel";
import type { Database } from "@/lib/supabase/types";

type Invoice = Database["public"]["Tables"]["invoices"]["Row"];
type LineItem = Database["public"]["Tables"]["invoice_line_items"]["Row"];

export interface DocumentRef {
  name: string;
  url: string | null;
  isPdf: boolean;
  isImage: boolean;
}

export interface BillData {
  invoice: Invoice;
  primaryFileUrl: string | null;
  documentCount: number;
  lineItems: LineItem[];
  saveBill: (formData: FormData) => Promise<void>;
  saveLineItem: (
    lineItemId: string,
    formData: FormData
  ) => Promise<void>;
  deleteLineItem: (lineItemId: string) => Promise<void>;
}

interface DetailSplitProps {
  documents: DocumentRef[];
  bill?: BillData;
  uploadAction?: (formData: FormData) => Promise<void>; // add a document
  children: ReactNode; // side panel content (server-rendered)
}

// Three-pane detail: invoice document(s), the ApprovalMax-style bill panel,
// and the side panel. The document starts COLLAPSED (the bill is the main
// focus — that's where the detail lives); click the strip to view the
// document. The bill panel flexes like the side panel: fixed width when the
// document is open, expanding to fill when it's hidden. Authored by Araza.
export function DetailSplit({
  documents,
  bill,
  uploadAction,
  children,
}: DetailSplitProps) {
  const [showDoc, setShowDoc] = useState(false);
  const [billOpen, setBillOpen] = useState(true);
  const [docIndex, setDocIndex] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);

  const safeIndex = Math.min(docIndex, Math.max(documents.length - 1, 0));
  const doc = documents[safeIndex];
  const multi = documents.length > 1;

  const prevDoc = () =>
    setDocIndex((i) => (i + documents.length - 1) % documents.length);
  const nextDoc = () => setDocIndex((i) => (i + 1) % documents.length);

  return (
    <div className="flex min-w-0 flex-1">
      {showDoc ? (
        <div className="flex min-w-0 flex-1 flex-col border-r border-slate-200 bg-slate-100">
          <div className="flex flex-none items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2">
            <span className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setShowDoc(false)}
                title="Hide document"
                className="flex flex-none items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-50"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    d="M15 6l-6 6 6 6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Hide
              </button>
              {multi && (
                <span className="flex flex-none items-center gap-1 text-xs text-slate-500">
                  <button
                    type="button"
                    onClick={prevDoc}
                    title="Previous page"
                    className="rounded p-1 hover:bg-slate-100"
                  >
                    ‹
                  </button>
                  <span className="tabular-nums">
                    {safeIndex + 1} / {documents.length}
                  </span>
                  <button
                    type="button"
                    onClick={nextDoc}
                    title="Next page"
                    className="rounded p-1 hover:bg-slate-100"
                  >
                    ›
                  </button>
                </span>
              )}
              <span className="truncate text-sm font-medium text-slate-700">
                {doc?.name ?? "Document"}
              </span>
            </span>
            <span className="flex flex-none items-center gap-3">
              {doc?.url && (
                <a
                  href={doc.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-medium text-blue-600 hover:underline"
                >
                  Open in new tab ↗
                </a>
              )}
              {uploadAction && (
                <form ref={formRef} action={uploadAction} className="flex-none">
                  <label className="cursor-pointer rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-50">
                    Add document
                    <input
                      type="file"
                      name="file"
                      accept=".pdf,image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files?.length) {
                          formRef.current?.requestSubmit();
                        }
                      }}
                    />
                  </label>
                </form>
              )}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {doc?.url ? (
              doc.isImage ? (
                // Deliberately a plain <img>: the source is an expiring
                // signed URL for a user-uploaded document, not something
                // next/image can optimize.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={doc.url}
                  alt={doc.name}
                  className="mx-auto max-w-full rounded-md shadow"
                />
              ) : doc.isPdf ? (
                <object
                  data={doc.url}
                  type="application/pdf"
                  className="h-full w-full"
                >
                  <p className="text-sm text-slate-500">
                    Your browser can&apos;t display this PDF.{" "}
                    <a
                      href={doc.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 underline"
                    >
                      Open it instead
                    </a>
                    .
                  </p>
                </object>
              ) : (
                <p className="text-sm text-slate-500">
                  No preview for this file type.{" "}
                  <a
                    href={doc.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 underline"
                  >
                    Open file
                  </a>
                  .
                </p>
              )
            ) : (
              <p className="text-sm text-slate-500">
                File preview unavailable.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-none flex-col items-center gap-3 border-r border-slate-200 bg-slate-100 py-3">
          <button
            type="button"
            onClick={() => setShowDoc(true)}
            title="Show document"
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-200"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                d="M9 6l6 6-6 6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <span className="text-[11px] font-medium text-slate-400 [writing-mode:vertical-rl]">
            Documents ({documents.length})
          </span>
        </div>
      )}

      {bill && (billOpen ? (
        <div
          className={
            showDoc ? "w-[480px] flex-none" : "min-w-0 flex-[3]"
          }
        >
          <BillPanel
            invoice={bill.invoice}
            primaryFileUrl={bill.primaryFileUrl}
            documentCount={bill.documentCount}
            lineItems={bill.lineItems}
            saveBill={bill.saveBill}
            saveLineItem={bill.saveLineItem}
            deleteLineItem={bill.deleteLineItem}
            onCollapse={() => setBillOpen(false)}
          />
        </div>
      ) : (
        <div className="flex flex-none flex-col items-center gap-3 border-r border-slate-200 bg-white py-3">
          <button
            type="button"
            onClick={() => setBillOpen(true)}
            title="Show bill"
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                d="M9 6l6 6-6 6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <span className="text-[11px] font-medium text-slate-400 [writing-mode:vertical-rl]">
            Bill
          </span>
        </div>
      ))}

      <div
        className={
          showDoc
            ? "w-[360px] flex-none overflow-y-auto bg-white"
            : "min-w-0 flex-[2] overflow-y-auto bg-white"
        }
      >
        {children}
      </div>
    </div>
  );
}
