"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  BillPanel,
  type BillApprovalData,
  type BillAdminData,
  type BillInstructionsData,
} from "./BillPanel";
import { ResizeHandle } from "./ResizeHandle";
import { useDocumentFocus } from "./DocumentFocusContext";
import type { SupplierDefaultsValues } from "./SupplierRulesModal";
import type { Database } from "@/lib/supabase/types";
import type { AuditTimelineEntry } from "@/lib/audit-timeline";

type Invoice = Database["public"]["Tables"]["invoices"]["Row"];
type LineItem = Database["public"]["Tables"]["invoice_line_items"]["Row"];
type Comment = Database["public"]["Tables"]["invoice_comments"]["Row"];

// "Add document" is a label (styled as a button) wrapping a hidden file
// input, not a real submit button — but the upload it triggers still
// needs the same "did that register" feedback as everywhere else.
function UploadLabel({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <label
      className={`cursor-pointer rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-50 ${
        pending ? "opacity-60" : ""
      }`}
    >
      {pending ? "Uploading…" : "Add document"}
      {children}
    </label>
  );
}

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
  projects: { id: string; name: string }[];
  // QBO mirrors (read-only) for dropdowns on the Bill panel.
  qboCategories?: string[];
  qboSuppliers?: string[];
  qboClasses?: string[];
  qboTaxRates?: { value: string; label: string; secondaryValue?: string }[];
  // True when qboTaxRates came from the org's synced QBO TaX CODES (each
  // option's value is the QBO tax code id — see BillPanel's Tax field).
  // False means it fell back to plain rates with no code identity at all
  // (no tax codes synced yet), which can't produce a TaxCodeRef.
  qboTaxUsesCodes?: boolean;
  // Settings → the org's default tax rate/code for new invoices — used to
  // pre-fill a freshly-added line's Tax field.
  orgDefaultTaxRate?: number | null;
  orgDefaultTaxCodeId?: string | null;
  // Rate-only options (no tax code id) for the vendor default-rules Tax
  // field — supplier_defaults.tax_rate has no code identity to attach.
  qboSupplierDefaultTaxRates?: { value: string; label: string }[];
  saveBill: (formData: FormData) => Promise<void>;
  saveLineItem: (
    lineItemId: string,
    formData: FormData
  ) => Promise<void>;
  deleteLineItem: (lineItemId: string) => Promise<void>;
  cloneLineItem: (lineItemId: string) => Promise<void>;
  reExtract: () => Promise<void>;
  getPageCount: (invoiceId: string) => Promise<number | null>;
  reorderPages: (
    invoiceId: string,
    order: number[]
  ) => Promise<{ ok: boolean; error?: string }>;
  backToReview: () => Promise<void>;
  canReview: boolean;
  readOnly: boolean;
  classReadOnly: boolean;
  canComment: boolean;
  supplierDefaults: SupplierDefaultsValues;
  saveSupplierDefaults: (formData: FormData) => Promise<void>;
  auditTimeline: AuditTimelineEntry[];
  comments: Comment[];
  authorNameById: Map<string, string>;
  addComment: (formData: FormData) => Promise<void>;
  members: { id: string; label: string }[];
  approval: BillApprovalData;
  admin: BillAdminData;
  instructions: BillInstructionsData;
  qboConnected: boolean;
  qboRealmId: string | null;
  // The invoice's vendor, matched (by normalized name, same as sync) to a
  // QBO Vendor id — null if unmatched. Backs the "Open vendor in
  // QuickBooks Online" link.
  qboVendorId: string | null;
  alerts?: ReactNode;
}

interface DetailSplitProps {
  documents: DocumentRef[];
  bill?: BillData;
  uploadAction?: (formData: FormData) => Promise<void>; // add a document
  canEdit?: boolean; // auditors are read-only
  // Whether the document viewer should start open — driven by the `doc=1`
  // URL param (see openDocument/hideDocument below), not just local state,
  // so it survives Prev/Next and Back/Forward navigation between invoices
  // rather than depending on this component instance never remounting.
  initialShowDoc?: boolean;
}

// Two-pane detail: invoice document(s) and the ApprovalMax-style bill panel.
// The document starts COLLAPSED (the bill is the main focus — that's where
// the detail lives); click the strip to view the document. The bill takes a
// fixed, draggable width while the document is open and expands to fill the
// pane once it's hidden. Authored by Araza.
export function DetailSplit({
  documents,
  bill,
  uploadAction,
  canEdit = true,
  initialShowDoc = false,
}: DetailSplitProps) {
  const [showDoc, setShowDoc] = useState(initialShowDoc);
  const [billOpen, setBillOpen] = useState(true);
  const [docIndex, setDocIndex] = useState(0);
  const [billW, setBillW] = useState(480);
  const outerRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const docScrollerRef = useRef<HTMLDivElement>(null);
  const billRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const { setFocused } = useDocumentFocus();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Keep the `doc=1` URL param in sync with showDoc — so "document open"
  // travels with the invoice through Prev/Next and Back/Forward, instead
  // of depending on this component instance never remounting.
  const setDocParam = (open: boolean) => {
    const params = new URLSearchParams(searchParams.toString());
    if (open) params.set("doc", "1");
    else params.delete("doc");
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  };

  // Switching invoices (navigation keeps this component mounted) must not
  // carry the previous invoice's scroll position into the new one — reset
  // both panes to the top. Also resync showDoc/focused from the URL's
  // doc=1 param specifically when the INVOICE changes (Prev/Next, Back/
  // Forward, a fresh link) — not on every render, which would fight the
  // user's own openDocument/hideDocument clicks on the current invoice.
  const invoiceId = bill?.invoice.id;
  useEffect(() => {
    docScrollerRef.current?.scrollTo({ top: 0 });
    setShowDoc(initialShowDoc);
    setFocused(initialShowDoc);
    if (initialShowDoc) setDocIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId]);

  // Snap to a 55/45 split (bill/document) every time the document opens —
  // the bill is the thing actually being worked on, the document is a
  // reference — the sidebar and invoice list have just hidden (see
  // setFocused below), so this pane's own width has grown to the full
  // screen by the time this runs (useLayoutEffect fires after that DOM
  // update, before paint, so there's no visible flash of the old width
  // first). Floored at 600px — a document-first split on a smaller/laptop
  // screen was squeezing the bill's line-items table (Description
  // especially) down to an unreadably narrow, cramped column. Still a real
  // drag handle afterward if a different width is genuinely wanted.
  useLayoutEffect(() => {
    if (showDoc && outerRef.current) {
      const total = outerRef.current.getBoundingClientRect().width;
      setBillW(Math.max(600, Math.round(total * 0.55)));
    }
  }, [showDoc]);

  // If this pane disappears for any reason while a document is open (e.g.
  // the invoice gets deselected), the sidebar/list must come back — there
  // would otherwise be nothing left on screen to un-focus with.
  useEffect(() => () => setFocused(false), [setFocused]);

  const safeIndex = Math.min(docIndex, Math.max(documents.length - 1, 0));
  const doc = documents[safeIndex];
  const multi = documents.length > 1;

  const openDocument = () => {
    setShowDoc(true);
    setFocused(true);
    setDocIndex(0);
    setDocParam(true);
  };

  const hideDocument = () => {
    setShowDoc(false);
    setFocused(false);
    setDocParam(false);
  };

  const prevDoc = () =>
    setDocIndex((i) => (i + documents.length - 1) % documents.length);
  const nextDoc = () => setDocIndex((i) => (i + 1) % documents.length);

  return (
    <div ref={outerRef} className="flex min-w-0 flex-1">
      {showDoc ? (
        <div
          ref={docRef}
          className="flex min-w-0 flex-1 flex-col border-r border-slate-200 bg-slate-100"
        >
          <div className="flex flex-none items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2">
            <span className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={hideDocument}
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
              {uploadAction && canEdit && (
                <form ref={formRef} action={uploadAction} className="flex-none">
                  <UploadLabel>
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
                  </UploadLabel>
                </form>
              )}
            </span>
          </div>
          <div ref={docScrollerRef} className="min-h-0 flex-1 overflow-auto p-4">
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
        <div className="flex w-10 flex-none flex-col items-center gap-3 border-r border-slate-200 bg-slate-100 py-3">
          <button
            type="button"
            onClick={openDocument}
            title="Show document"
            className="rounded-md border border-slate-300 bg-white p-2 text-slate-700 shadow-sm hover:border-blue-400 hover:text-blue-600"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path
                d="M9 6l6 6-6 6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <span className="text-xs font-semibold text-slate-700 [writing-mode:vertical-rl]">
            Documents ({documents.length})
          </span>
        </div>
      )}

      {/* The split between the two panes. The document always absorbs the
          surplus (flex-1) and the bill holds a fixed width, so dragging
          adjusts the bill inversely — right shrinks it, left grows it —
          and the pair always fills the pane exactly. */}
      {showDoc && billOpen && (
        <ResizeHandle
          onDrag={(dx) =>
            setBillW((w) => Math.min(1600, Math.max(320, w - dx)))
          }
        />
      )}

      {bill && (billOpen ? (
        <div
          ref={billRef}
          style={showDoc ? { width: billW } : undefined}
          className={showDoc ? "flex-none" : "min-w-0 flex-1"}
        >
          <BillPanel
            invoice={bill.invoice}
            documentCount={bill.documentCount}
            lineItems={bill.lineItems}
            projects={bill.projects}
            qboCategories={bill.qboCategories}
            qboSuppliers={bill.qboSuppliers}
            qboClasses={bill.qboClasses}
            qboTaxRates={bill.qboTaxRates}
            qboTaxUsesCodes={bill.qboTaxUsesCodes}
            orgDefaultTaxRate={bill.orgDefaultTaxRate}
            orgDefaultTaxCodeId={bill.orgDefaultTaxCodeId}
            qboSupplierDefaultTaxRates={bill.qboSupplierDefaultTaxRates}
            saveBill={bill.saveBill}
            saveLineItem={bill.saveLineItem}
            deleteLineItem={bill.deleteLineItem}
            cloneLineItem={bill.cloneLineItem}
            reExtract={bill.reExtract}
            getPageCount={bill.getPageCount}
            reorderPages={bill.reorderPages}
            backToReview={bill.backToReview}
            canReview={bill.canReview}
            readOnly={bill.readOnly}
            classReadOnly={bill.classReadOnly}
            canComment={bill.canComment}
            supplierDefaults={bill.supplierDefaults}
            saveSupplierDefaults={bill.saveSupplierDefaults}
            auditTimeline={bill.auditTimeline}
            comments={bill.comments}
            authorNameById={bill.authorNameById}
            addComment={bill.addComment}
            members={bill.members}
            approval={bill.approval}
            admin={bill.admin}
            instructions={bill.instructions}
            qboConnected={bill.qboConnected}
            qboRealmId={bill.qboRealmId}
            qboVendorId={bill.qboVendorId}
            alerts={bill.alerts}
            onOpenDocument={openDocument}
            onCollapse={() => setBillOpen(false)}
            resetScrollKey={bill.invoice.id}
          />
        </div>
      ) : (
        <div className="flex w-10 flex-none flex-col items-center gap-3 border-r border-slate-200 bg-slate-100 py-3">
          <button
            type="button"
            onClick={() => setBillOpen(true)}
            title="Show bill"
            className="rounded-md border border-slate-300 bg-white p-2 text-slate-700 shadow-sm hover:border-blue-400 hover:text-blue-600"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path
                d="M9 6l6 6-6 6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <span className="text-xs font-semibold text-slate-700 [writing-mode:vertical-rl]">
            Bill
          </span>
        </div>
      ))}
    </div>
  );
}
