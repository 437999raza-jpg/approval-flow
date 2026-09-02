import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, InvoiceSource } from "@/lib/supabase/types";
import { extractInvoiceFields, type ExtractedInvoiceData } from "@/lib/extract-invoice";
import { selectWorkflowForInvoice } from "@/lib/workflow-routing";
import { matchProject } from "@/lib/project-matching";
import { matchSupplier } from "@/lib/qbo";
import { fetchAllQboSuppliers } from "@/lib/qbo-all";
import { computeLineItemTotals } from "@/lib/invoice-totals";
import { extractionModeForOrg } from "@/lib/plans";
import { categoryDisplayName } from "@/lib/qbo";
import { syncInvoiceRetainage } from "@/lib/retainage-sync";
import { resolveSupplier } from "@/lib/suppliers";

const INVOICE_BUCKET = "invoices";
export const MAX_INVOICE_FILE_BYTES = 20 * 1024 * 1024; // 20MB
export const ALLOWED_INVOICE_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export class InvoiceIngestError extends Error {}

export function invoiceFileValidationError(file: Pick<File, "size" | "type">): string | null {
  if (file.size === 0) return "File is empty";
  if (file.size > MAX_INVOICE_FILE_BYTES) {
    return `File exceeds ${MAX_INVOICE_FILE_BYTES / 1024 / 1024}MB limit`;
  }
  if (!ALLOWED_INVOICE_TYPES.has(file.type)) {
    return `Unsupported file type: ${file.type || "unknown"}`;
  }
  return null;
}

export function validateInvoiceFile(file: Pick<File, "size" | "type">) {
  const error = invoiceFileValidationError(file);
  if (error) throw new InvoiceIngestError(error);
}

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
  project_id: string | null;
  tax_rate: number | null;
  payment_terms_days: number | null;
  currency: string | null;
}

// Dext/ApprovalMax-style supplier rules, keyed by the real Supplier
// entity (migration 0092, resolveSupplier() in src/lib/suppliers.ts) —
// resolve the supplier first, then look up its rule by id, rather than
// re-normalizing vendor-name text at every call site.
export async function getSupplierDefaults(
  supabase: SupabaseClient<Database>,
  organizationId: string,
  supplierId: string | null
): Promise<SupplierDefaults | null> {
  if (!supplierId) return null;
  const { data } = await supabase
    .from("supplier_defaults")
    .select("category, class, project_id, tax_rate, payment_terms_days, currency")
    .eq("organization_id", organizationId)
    .eq("supplier_id", supplierId)
    .maybeSingle();
  return data ?? null;
}

export function addDays(dateStr: string, days: number): string {
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
// "HB", "hold back", "hold-back", "holdback", "less 10%", "5% hold" —
// ANY percentage, not ten. Ontario holdback is 10%, but US retainage is
// commonly 5% and often steps down mid-project, so a hardcoded 10 would
// simply have stopped recognising the line for anyone outside Ontario.
export function holdbackCategoryFor(
  li: { description: string | null },
  // The org's own holdback account label, e.g. "2-1031 - HB Payable".
  // This used to be that exact string hardcoded — Fluid's account, in
  // shared code, applied to every tenant. Any other customer's bills
  // would have been coded to an account their QuickBooks has never
  // heard of. Null (no account configured) means don't guess at all.
  accountLabel: string | null
): string | null {
  if (!accountLabel) return null;
  const desc = (li.description ?? "").toLowerCase();
  return /\bhb\b|hold\s*-?\s*back|less\s*\d+(\.\d+)?\s*%|\d+(\.\d+)?\s*%\s*hold/.test(desc)
    ? accountLabel
    : null;
}

// "Simple" extraction mode (see extractionModeForOrg in src/lib/plans.ts —
// derived from the org's plan, "complex" only for the Detailed plan or an
// active trial): Dext-style, one line item per invoice instead of the full
// line-by-line breakdown. The model still extracts the whole document
// exactly as it does for "complex" mode — only which line item(s) get
// built from that extraction differs. Amount is the document's own printed SUBTOTAL (not
// the total, which would double-count tax once computeLineItemTotals
// applies tax_rate); category/class come from the vendor's saved supplier
// rule, or land blank for the human to set once (which then persists for
// every future invoice from that vendor, same as detailed mode).
export function buildSimpleLineItem(
  extracted: Pick<ExtractedInvoiceData, "subtotal" | "tax_rate" | "total_amount">,
  supplierDefaults: SupplierDefaults | null,
  orgDefaultTaxRate: number | null,
  orgDefaultTaxCodeId: string | null,
  projectId: string | null
) {
  const appliedRate =
    supplierDefaults?.tax_rate ?? orgDefaultTaxRate ?? extracted.tax_rate;
  return [
    {
      description: null,
      // The model doesn't always separate subtotal from the printed total
      // (some documents only show one number) — fall back to the total
      // rather than silently storing a $0 line, same as the detailed
      // mode's own no-line-items fallback just below.
      amount: extracted.subtotal ?? extracted.total_amount,
      tax_rate: appliedRate,
      qbo_tax_code_id: taxCodeIdFor(appliedRate, orgDefaultTaxRate, orgDefaultTaxCodeId),
      category: supplierDefaults?.category ?? null,
      class: supplierDefaults?.class ?? null,
      project_id: projectId,
    },
  ];
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
  validateInvoiceFile(file);

  const safeName = file.name.replace(/[^\w.\-]+/g, "_");
  const filePath = `${organizationId}/${crypto.randomUUID()}-${safeName}`;

  const [{ error: uploadError }, extracted] = await Promise.all([
    supabase.storage
      .from(INVOICE_BUCKET)
      .upload(filePath, file, { contentType: file.type, upsert: false }),
    extractInvoiceFields(file, extraContext, organizationId),
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
  let matchedQboVendorId: string | null = null;
  if (extracted?.vendor_name) {
    // Paginated: PostgREST caps responses at 1000 rows, and the mirror has
    // 2,045 — matching against a truncated list would silently keep the
    // OCR name and break the QBO push later.
    const qboSuppliers = await fetchAllQboSuppliers(supabase, organizationId);
    matchedVendorName = matchSupplier(qboSuppliers, extracted.vendor_name);
    matchedQboVendorId = matchedVendorName
      ? qboSuppliers.find((s) => s.name === matchedVendorName)?.qbo_vendor_id ?? null
      : null;
  }
  const vendorName = matchedVendorName ?? extracted?.vendor_name ?? null;
  const qboVendorMatched = matchedVendorName !== null;

  // Find-or-create the real Supplier row for this vendor name (migration
  // 0092) — the stable identity duplicate detection, supplier rules, and
  // statement matching key off, instead of re-normalizing text at every
  // read site. A confirmed QBO match links the real vendor id too.
  const supplier = await resolveSupplier(supabase, organizationId, vendorName, matchedQboVendorId);

  // Dext/ApprovalMax-style: a saved supplier rule wins over whatever the
  // extraction guessed for the fields it covers — it's a business rule a
  // human configured on purpose, not a best-effort read of the document.
  const supplierDefaults = await getSupplierDefaults(
    supabase,
    organizationId,
    supplier?.id ?? null
  );

  // Org-wide default tax (Settings → Data from QuickBooks). Stored as a
  // specific QBO tax CODE (e.g. H 13%) so lines carry an unambiguous code —
  // duplicate-rate codes (H vs M&E (ON), both 13%) can't be guessed at sync
  // time. Applied to line items that have no supplier rule and no rate from
  // extraction.
  const { data: org } = await supabase
    .from("organizations")
    .select("default_tax_rate, default_tax_code_id, plan, custom_plan, trial_ends_at, retainage_account_qbo_id")
    .eq("id", organizationId)
    .single();
  const orgDefaultTaxRate = org?.default_tax_rate ?? null;

  // The org's holdback account, resolved once. Extraction only auto-codes
  // a deduction line when the org actually has one configured.
  let retainageAccountLabel: string | null = null;
  if (org?.retainage_account_qbo_id) {
    const { data: hbAccount } = await supabase
      .from("qbo_categories")
      .select("acct_num, name")
      .eq("organization_id", organizationId)
      .eq("qbo_account_id", org.retainage_account_qbo_id)
      .maybeSingle();
    if (hbAccount) {
      retainageAccountLabel = categoryDisplayName({
        acctNum: hbAccount.acct_num,
        name: hbAccount.name,
      });
    }
  }
  const orgDefaultTaxCodeId = org?.default_tax_code_id ?? null;
  const isSimpleMode = extractionModeForOrg(org) === "simple";

  // Which job this bill belongs to. Projects come from QuickBooks (or are
  // created by hand in Flow — both count), and the supplier usually cites
  // the job somewhere: on the PO, in a line description, in the memo.
  // Project is always a per-bill choice — a supplier works on many jobs —
  // so it is never taken from a supplier rule.
  //
  // Only a high or medium confidence match is applied. A low one means
  // the job's NAME was spotted in free text, which is a reasonable hint
  // for a human and a poor reason to file a bill automatically: an
  // unassigned job gets noticed and fixed, a wrongly assigned one gets
  // approved.
  let detectedProjectId: string | null = null;
  const projectSignals = [
    extracted?.po_number,
    ...(extracted?.line_items ?? []).map((li) => li.description),
  ].filter(Boolean);
  if (projectSignals.length > 0) {
    const { data: orgProjects } = await supabase
      .from("projects")
      .select("id, name")
      .eq("organization_id", organizationId)
      .eq("active", true);
    const match = matchProject(orgProjects ?? [], {
      poNumber: extracted?.po_number ?? null,
      texts: (extracted?.line_items ?? []).map((li) => li.description),
    });
    if (match && match.confidence !== "low") {
      detectedProjectId = match.projectId;
    }
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
  const hasLineItems = isSimpleMode || (!!extracted && extracted.line_items.length > 0);
  const finalLineItems = isSimpleMode
    ? buildSimpleLineItem(
        {
          subtotal: extracted?.subtotal ?? null,
          tax_rate: extracted?.tax_rate ?? null,
          total_amount: extracted?.total_amount ?? null,
        },
        supplierDefaults,
        orgDefaultTaxRate,
        orgDefaultTaxCodeId,
        projectId
      )
    : hasLineItems
    ? extracted!.line_items.map((li) => {
        // A holdback read as a positive amount is still a deduction — negate
        // it so the bill math stays right (the category rule matches it).
        const hbCat = holdbackCategoryFor(li, retainageAccountLabel);
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
            project_id: projectId,
          },
        ]
      : [];

  // Totals: ALWAYS derived from the actual line items — amount/tax_amount
  // are what's really entered right now, never silently swapped for the
  // document's own printed total. When they disagree, totals_note flags it
  // as a warning for the reviewer to go fix (a missed line, a wrong
  // amount) — the fix is correcting the line items until the derived total
  // naturally matches the document, not the app picking a different
  // number to display. (Previously the document total won outright when
  // they disagreed — reversed because that hid real line-item mistakes
  // instead of surfacing them.)
  const derived = computeLineItemTotals(finalLineItems);
  const computedAmount = hasLineItems ? derived.total : (extracted?.total_amount ?? null);
  const computedTax = hasLineItems ? derived.tax : (extracted?.tax_amount ?? null);
  let totalsNote: string | null = null;

  if (hasLineItems) {
    const printedTotal = extracted?.total_amount ?? null;
    if (
      printedTotal != null &&
      Math.abs(printedTotal - derived.total) > 0.01
    ) {
      totalsNote = `Document total ${printedTotal.toFixed(2)} differs from these line items (${derived.total.toFixed(2)}). Check the line items above — a missing or wrong amount is the usual cause.`;
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
      supplier_id: supplier?.id ?? null,
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
    // Record any holdback on this bill now, so the Holdback report reads
    // a table rather than rescanning every invoice on each page load.
    await syncInvoiceRetainage(supabase, organizationId, invoice.id);
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
