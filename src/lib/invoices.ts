import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, InvoiceSource } from "@/lib/supabase/types";
import { extractInvoiceFields } from "@/lib/extract-invoice";
import { selectWorkflowForInvoice } from "@/lib/workflow-routing";
import { normalizeForMatching, matchProjectFromPoNumber } from "@/lib/matching";
import { matchSupplier } from "@/lib/qbo";
import { fetchAllQboSuppliers } from "@/lib/qbo-all";
import { computeLineItemTotals } from "@/lib/invoice-totals";

const INVOICE_BUCKET = "invoices";
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export class InvoiceIngestError extends Error {}

// Thrown by createInvoiceFromFile when the document clearly isn't an
// invoice (no invoice number, no total, no line items) — the Queue shows
// these as "No invoice data found" instead of creating a junk invoice.
export const NO_INVOICE_DATA_ERROR =
  "No invoice data found — this document does not look like an invoice.";

// A successful extraction counts as an invoice ONLY when it found
// invoice-defining data — a number, totals, tax, a PO, or line items.
// A vendor name and/or description read from a logo, signature strip, or
// certificate (e.g. WSIB clearance, insurance) is NOT an invoice: those
// produced blank junk bills. Such documents are rejected as "No invoice
// data found" instead of creating a bill the reviewer has to throw away
// (staging is kept, so the Queue's Reprocess can still re-run them).
function isEmptyExtraction(extracted: {
  invoice_number: string | null;
  total_amount: number | null;
  subtotal: number | null;
  tax_amount: number | null;
  po_number: string | null;
  line_items: unknown[];
}): boolean {
  return (
    !extracted.invoice_number &&
    extracted.total_amount == null &&
    extracted.subtotal == null &&
    extracted.tax_amount == null &&
    !extracted.po_number &&
    extracted.line_items.length === 0
  );
}

export interface SupplierDefaults {
  category: string | null;
  class: string | null;
  product_service: string | null;
  project_id: string | null;
  tax_rate: number | null;
  payment_terms_days: number | null;
  currency: string | null;
}

// Dext/ApprovalMax-style supplier rules, matched by normalized (trim+lower)
// vendor name — there's no first-class Supplier entity yet, so this is a
// pragmatic v1. Configured via the "Supplier rules" modal on the Bill panel.
export async function getSupplierDefaults(
  supabase: SupabaseClient<Database>,
  organizationId: string,
  vendorName: string | null
): Promise<SupplierDefaults | null> {
  if (!vendorName?.trim()) return null;
  const { data } = await supabase
    .from("supplier_defaults")
    .select("category, class, product_service, project_id, tax_rate, payment_terms_days, currency")
    .eq("organization_id", organizationId)
    .eq("vendor_name_normalized", normalizeForMatching(vendorName))
    .maybeSingle();
  return data ?? null;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Pure. The org's default tax code (e.g. H) is only a known-good match for
// the org's own default RATE (e.g. 13%) — it says nothing about a rate that
// happens to differ. A line's applied rate might come from a supplier rule
// rather than the org default, but if that rule's rate is the SAME number,
// there's no real ambiguity: the org has already declared which code that
// rate means. Only an applied rate that differs from the org default has no
// known code and resolves to null here, left for sync-time rate matching
// (resolveTaxCode/matchTaxCode in qbo.ts) to resolve or fail loudly on.
export function taxCodeIdFor(
  appliedRate: number | null | undefined,
  orgDefaultTaxRate: number | null,
  orgDefaultTaxCodeId: string | null
): string | null {
  if (appliedRate == null || orgDefaultTaxRate == null || orgDefaultTaxCodeId == null) {
    return null;
  }
  return Math.abs(appliedRate - orgDefaultTaxRate) < 0.005 ? orgDefaultTaxCodeId : null;
}

// Business rule: when a line item's description mentions a holdback (HB),
// the category is HB Payable (2-1031 in QBO) — regardless of sign. The
// caller also negates a positive holdback amount (the model sometimes reads
// the deduction as positive), so the bill math stays correct. Matches
// "HB", "hold back", "hold-back", "holdback", "less 10%", "10% hold".
export function holdbackCategoryFor(li: {
  description: string | null;
}): string | null {
  const desc = (li.description ?? "").toLowerCase();
  return /\bhb\b|hold\s*-?\s*back|less\s*10\s*%|10\s*%\s*hold/.test(desc)
    ? "2-1031 - HB Payable"
    : null;
}

interface CreateInvoiceArgs {
  supabase: SupabaseClient<Database>;
  organizationId: string;
  file: File;
  source: InvoiceSource;
  submittedBy?: string; // profile id, for manual uploads
  sourceEmail?: string; // sender address, for email uploads
  extraContext?: string; // e.g. the inbound email subject, to help extraction
}

// Single entry point for turning a file into an invoice record, regardless
// of whether it arrived via the "Add invoice" button or the inbound-email
// webhook. Uploads the file to Storage, inserts the invoice row against the
// org's default approval workflow, and writes an audit log entry.
export async function createInvoiceFromFile({
  supabase,
  organizationId,
  file,
  source,
  submittedBy,
  sourceEmail,
  extraContext,
}: CreateInvoiceArgs) {
  if (file.size === 0) {
    throw new InvoiceIngestError("File is empty");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new InvoiceIngestError(`File exceeds ${MAX_FILE_BYTES / 1024 / 1024}MB limit`);
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    throw new InvoiceIngestError(`Unsupported file type: ${file.type || "unknown"}`);
  }

  const safeName = file.name.replace(/[^\w.\-]+/g, "_");
  const filePath = `${organizationId}/${crypto.randomUUID()}-${safeName}`;

  const [{ error: uploadError }, extracted] = await Promise.all([
    supabase.storage
      .from(INVOICE_BUCKET)
      .upload(filePath, file, { contentType: file.type, upsert: false }),
    extractInvoiceFields(file, extraContext),
  ]);

  if (uploadError) {
    throw new InvoiceIngestError(`Upload failed: ${uploadError.message}`);
  }

  // A failed extraction call is RETRYABLE, never "not an invoice" — a
  // transient OpenRouter hiccup must not permanently reject a real invoice.
  if (!extracted) {
    await supabase.storage.from(INVOICE_BUCKET).remove([filePath]);
    throw new InvoiceIngestError(
      "Extraction returned no result — retrying."
    );
  }

  // "Not an invoice" guard: a SUCCESSFUL extraction only counts as an
  // invoice when it found invoice-defining data (number, totals, tax, PO,
  // or line items). A vendor name and/or description read from a logo,
  // signature strip, or certificate is NOT an invoice — those were
  // creating blank junk bills. The caller surfaces this as "No invoice
  // data found" in the Queue instead of creating a junk invoice (staging
  // is kept, so Reprocess can still re-run it).
  if (isEmptyExtraction(extracted)) {
    await supabase.storage.from(INVOICE_BUCKET).remove([filePath]);
    throw new InvoiceIngestError(NO_INVOICE_DATA_ERROR);
  }

  // RULE: Flow never creates suppliers in QuickBooks. Match the OCR'd
  // vendor EXACTLY (normalized) against the read-only QBO mirror. An exact
  // match stores the canonical QBO name; no match keeps the OCR name but
  // flags the invoice (qbo_vendor_matched=false) so it's visibly marked
  // and can't sync until a human picks the right supplier.
  let matchedVendorName: string | null = null;
  if (extracted?.vendor_name) {
    // Paginated: PostgREST caps responses at 1000 rows, and the mirror has
    // 2,045 — matching against a truncated list would silently keep the
    // OCR name and break the QBO push later.
    const qboSuppliers = await fetchAllQboSuppliers(supabase, organizationId);
    matchedVendorName = matchSupplier(qboSuppliers, extracted.vendor_name);
  }
  const vendorName = matchedVendorName ?? extracted?.vendor_name ?? null;
  const qboVendorMatched = matchedVendorName !== null;

  // Dext/ApprovalMax-style: a saved supplier rule wins over whatever the
  // extraction guessed for the fields it covers — it's a business rule a
  // human configured on purpose, not a best-effort read of the document.
  const supplierDefaults = await getSupplierDefaults(
    supabase,
    organizationId,
    vendorName
  );

  // Org-wide default tax (Settings → Data from QuickBooks). Stored as a
  // specific QBO tax CODE (e.g. H 13%) so lines carry an unambiguous code —
  // duplicate-rate codes (H vs M&E (ON), both 13%) can't be guessed at sync
  // time. Applied to line items that have no supplier rule and no rate from
  // extraction.
  const { data: org } = await supabase
    .from("organizations")
    .select("default_tax_rate, default_tax_code_id")
    .eq("id", organizationId)
    .single();
  const orgDefaultTaxRate = org?.default_tax_rate ?? null;
  const orgDefaultTaxCodeId = org?.default_tax_code_id ?? null;

  // Project detection from the PO number: suppliers commonly put their job
  // number on the PO ("2022-589-PO-1234" starts with project code 2022-58).
  // Project is always a per-bill choice (a supplier can work on many jobs),
  // so it comes from the PO match, never from a supplier rule.
  let detectedProjectId: string | null = null;
  if (extracted?.po_number) {
    const { data: orgProjects } = await supabase
      .from("projects")
      .select("id, name")
      .eq("organization_id", organizationId)
      .eq("source", "qbo")
      .eq("active", true);
    detectedProjectId = matchProjectFromPoNumber(
      orgProjects ?? [],
      extracted.po_number
    );
  }
  const projectId = detectedProjectId ?? null;

  // Build the line items with any supplier-rule overrides applied first,
  // then derive the invoice's amount/tax from THOSE final line items (tax
  // per line as amount × tax rate%, blank rate = no tax) — not the
  // document's own printed totals, and not the pre-override tax rates.
  // When extraction found no line items there's nothing to derive from,
  // so the whole-document totals are the only numbers available.
  // Supplier rules carry Category, Class, Tax rate, Payment terms, Currency
  // — never Project (a supplier can work on many jobs, so that stays a
  // per-bill choice, detected from the PO number above instead).
  const hasLineItems = !!extracted && extracted.line_items.length > 0;
  const finalLineItems = hasLineItems
    ? extracted!.line_items.map((li) => {
        // A holdback read as a positive amount is still a deduction — negate
        // it so the bill math stays right (the category rule matches it).
        const hbCat = holdbackCategoryFor(li);
        const appliedRate =
          supplierDefaults?.tax_rate ??
          orgDefaultTaxRate ??
          li.tax_rate;
        return {
          description: li.description,
          amount:
            hbCat && (li.amount ?? 0) > 0 ? -(li.amount ?? 0) : li.amount,
          // Supplier rule > org default > what extraction guessed.
          tax_rate: appliedRate,
          // The org's default tax code is only a known-good match for the
          // org's own default RATE — a supplier rule's rate happening to
          // equal it too isn't a genuine ambiguity (the org already
          // declared which code that rate means); only a supplier rate
          // that DIFFERS from the org default has no known code, left for
          // sync-time rate matching to resolve (or fail loudly on if truly
          // ambiguous — see resolveTaxCode/matchTaxCode in qbo.ts).
          qbo_tax_code_id: taxCodeIdFor(appliedRate, orgDefaultTaxRate, orgDefaultTaxCodeId),
          category: hbCat ?? supplierDefaults?.category ?? li.category,
          // Class NEVER comes from the document — the org's classes are
          // totally different from whatever the supplier prints. Only a
          // supplier rule (app-side config) or a human can set it.
          class: supplierDefaults?.class ?? null,
          // Same reasoning as class: no QBO Item mirror exists yet, so this
          // is a plain free-text supplier default, never read from the
          // document itself.
          product_service: supplierDefaults?.product_service ?? null,
          project_id: projectId,
        };
      })
    : supplierDefaults
      ? [
          {
            description: null,
            amount: extracted?.total_amount ?? null,
            tax_rate: supplierDefaults.tax_rate ?? orgDefaultTaxRate,
            qbo_tax_code_id: taxCodeIdFor(
              supplierDefaults.tax_rate ?? orgDefaultTaxRate,
              orgDefaultTaxRate,
              orgDefaultTaxCodeId
            ),
            category: supplierDefaults.category,
            class: supplierDefaults.class,
            product_service: supplierDefaults.product_service,
            project_id: projectId,
          },
        ]
      : [];

  // Totals: derive from the final line items, then reconcile against the
  // DOCUMENT's own printed totals. The printed total is ground truth — when
  // it disagrees with the line-item sum, the document wins ("the total must
  // match at all costs"), and a note is recorded so the reviewer can see
  // what happened.
  const derived = computeLineItemTotals(finalLineItems);
  let computedAmount = hasLineItems ? derived.total : (extracted?.total_amount ?? null);
  let computedTax = hasLineItems ? derived.tax : (extracted?.tax_amount ?? null);
  let totalsNote: string | null = null;

  if (hasLineItems) {
    const printedTotal = extracted?.total_amount ?? null;
    if (
      printedTotal != null &&
      Math.abs(printedTotal - derived.total) > 0.01
    ) {
      computedAmount = printedTotal; // the document wins
      if (extracted?.tax_amount != null) computedTax = extracted.tax_amount;
      totalsNote = `Document total ${printedTotal.toFixed(2)} differs from line items (${derived.total.toFixed(2)}). The document total was used.`;
    } else if (printedTotal == null) {
      // The printed total couldn't be read at all — the number shown is
      // derived from line items and was never verified against the
      // document, so say so instead of silently presenting it as the total.
      totalsNote = `The document's printed total could not be read — the amount shown (${derived.total.toFixed(2)}) was derived from the line items. Please verify it against the invoice.`;
    }
  }

  // Route the invoice to the first workflow whose items all match; fall
  // back to the org's default workflow.
  const { data: submitterProfile } = submittedBy
    ? await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", submittedBy)
        .maybeSingle()
    : { data: null };
  const workflowId = await selectWorkflowForInvoice(supabase, organizationId, {
    amount: computedAmount,
    vendorName,
    submittedBy: submittedBy ?? null,
    submitterName: submitterProfile?.full_name ?? null,
    projects: [], // project is assigned per line item later in the Bill panel
    lineItems: [],
  });

  const billDate = extracted?.bill_date ?? null;
  const dueDate =
    supplierDefaults?.payment_terms_days != null && billDate
      ? addDays(billDate, supplierDefaults.payment_terms_days)
      : (extracted?.due_date ?? null);

  const { data: invoice, error: insertError } = await supabase
    .from("invoices")
    .insert({
      organization_id: organizationId,
      workflow_id: workflowId,
      status: "on_review", // sits in the Pending Review queue until
      // Review Done routes it into the approval workflow
      source,
      source_email: sourceEmail ?? null,
      submitted_by: submittedBy ?? null,
      file_path: filePath,
      file_name: file.name,
      vendor_name: vendorName,
      qbo_vendor_matched: qboVendorMatched,
      totals_note: totalsNote,
      invoice_number: extracted?.invoice_number ?? null,
      amount: computedAmount,
      document_total: extracted?.total_amount ?? null,
      currency: supplierDefaults?.currency ?? extracted?.currency ?? "USD",
      bill_date: billDate,
      due_date: dueDate,
      tax_amount: computedTax,
      extraction: extracted ? (extracted as unknown as Record<string, unknown>) : null,
    })
    .select()
    .single();

  if (insertError || !invoice) {
    await supabase.storage.from(INVOICE_BUCKET).remove([filePath]);
    throw new InvoiceIngestError(
      `Could not create invoice record: ${insertError?.message ?? "unknown error"}`
    );
  }

  // Populate the Bill panel's Category details from the final line items.
  const lineItemsToInsert = finalLineItems.map((li, i) => ({
    ...li,
    invoice_id: invoice.id,
    line_order: i + 1,
  }));

  if (lineItemsToInsert.length > 0) {
    await supabase.from("invoice_line_items").insert(lineItemsToInsert);
  }

  await supabase.from("audit_log").insert({
    organization_id: organizationId,
    invoice_id: invoice.id,
    actor_id: submittedBy ?? null,
    action: source === "email" ? "invoice.received_by_email" : "invoice.uploaded",
    metadata: source === "email" ? { source_email: sourceEmail } : null,
  });

  return invoice;
}
