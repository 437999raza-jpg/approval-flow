import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import {
  getQboConnection,
  listBillsForImport,
  listItemAccounts,
  listAttachmentsForBill,
  downloadAttachment,
  categoryDisplayName,
  type QboBillForImport,
} from "@/lib/qbo";
import { syncInvoiceRetainage } from "@/lib/retainage-sync";

// Historical bill import from QuickBooks — platform-admin only, run by
// hand when onboarding a paying customer who wants their pre-Flow
// QuickBooks history brought in. Never exposed under a customer's own
// Settings; see qbo_bill_import_jobs (migration 0104) for why that table
// carries no member-facing RLS policy at all.
//
// THE ONE RULE THAT MATTERS: every imported invoice is written already
// at its terminal, synced state — status "approved", qbo_sync_status
// "synced", qbo_bill_id set to the REAL bill it came from. Flow's own
// sync-to-QBO path (dashboard-actions.ts) only ever picks up invoices at
// status "qbo_ready" — confirmed by reading that guard before writing
// this file — so an imported bill can never be pushed back to QBO as a
// duplicate. The only way that could happen is an admin explicitly
// selecting an imported invoice and clicking "retry sync" by hand, the
// same risk that already exists for any invoice.
//
// LINE CATEGORIES come from whichever of QBO's two line shapes the bill
// actually used. Fluid's own holdback line is Product/Service-based, not
// Account-based (confirmed on a real bill, 8415 — "HB Payable" as an
// Item, not a category) — so both are resolved to the same category
// STRING every other line in the system already uses. Once that string
// matches the org's configured retainage account, syncInvoiceRetainage
// picks it up automatically; nothing here special-cases holdback at all.
//
// Authored by Araza.

type Supabase = SupabaseClient<Database>;

const BATCH_SIZE = 15; // bills PROCESSED per tick when every fetched
// bill goes all the way through (no project filter) — attachment
// downloads make each bill several HTTP round trips, and a batch this
// size comfortably fits a serverless function's time budget.

// When scoped to one project, most fetched bills get discarded before
// ever touching an attachment — QBO can't filter Bills by which project
// a LINE belongs to (CustomerRef lives on the line, not the bill header,
// and only header fields are queryable), so scoping is a post-fetch
// filter over whatever the date range returns. A three-year-old project
// crawling at 15 bills a tick would take forever; scan far more per
// tick and only pay the attachment cost for the ones that actually
// match.
const SCAN_PAGE_SIZE = 300;

export async function startQboBillImport(
  supabase: Supabase,
  organizationId: string,
  dateFrom: string,
  dateTo: string,
  createdBy: string,
  projectIds: string[] = []
): Promise<{ ok: boolean; error?: string }> {
  const { data: existing } = await supabase
    .from("qbo_bill_import_jobs")
    .select("id")
    .eq("organization_id", organizationId)
    .in("status", ["queued", "processing"])
    .maybeSingle();
  if (existing) {
    return { ok: false, error: "An import is already running for this organization." };
  }

  const { error } = await supabase.from("qbo_bill_import_jobs").insert({
    organization_id: organizationId,
    date_from: dateFrom,
    date_to: dateTo,
    project_ids: projectIds,
    created_by: createdBy,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// One batch, one tick. Resumable via cursor_position (QBO's own
// STARTPOSITION), so a killed function or a slow backlog just picks up
// next tick exactly where it left off.
export async function runQboBillImportJob(supabase: Supabase, organizationId: string): Promise<void> {
  const { data: job } = await supabase
    .from("qbo_bill_import_jobs")
    .select("*")
    .eq("organization_id", organizationId)
    .in("status", ["queued", "processing"])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!job) return;

  const conn = await getQboConnection(supabase, organizationId);
  if (!conn) {
    await supabase
      .from("qbo_bill_import_jobs")
      .update({ status: "error", last_error: "QuickBooks is not connected.", updated_at: new Date().toISOString() })
      .eq("id", job.id);
    return;
  }

  await supabase
    .from("qbo_bill_import_jobs")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("id", job.id);

  // Resolve the scoping projects' QBO ids once, if this job is scoped.
  let targetQboProjectIds: Set<string> | null = null;
  if (job.project_ids.length > 0) {
    const { data: projs } = await supabase
      .from("projects")
      .select("qbo_id")
      .in("id", job.project_ids);
    const ids = (projs ?? []).map((p) => p.qbo_id).filter((id): id is string => !!id);
    targetQboProjectIds = ids.length > 0 ? new Set(ids) : null;
  }

  let fetchedBills: QboBillForImport[];
  try {
    fetchedBills = await listBillsForImport(
      conn,
      job.date_from,
      job.date_to,
      job.cursor_position,
      targetQboProjectIds ? SCAN_PAGE_SIZE : BATCH_SIZE
    );
  } catch (err) {
    await supabase
      .from("qbo_bill_import_jobs")
      .update({
        status: "error",
        last_error: err instanceof Error ? err.message : "Failed to read bills from QuickBooks.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    return;
  }

  // Bringing in the WHOLE bill when any line touches the target project,
  // never a partial slice of one — a Bill is one real financial document
  // with its own total, vendor and attachment; splitting it would
  // misrepresent it. The line-level project a customer actually cares
  // about is preserved per line either way, same as it already is for
  // every live invoice in the app.
  const bills = targetQboProjectIds
    ? fetchedBills.filter((b) => b.lines.some((l) => l.customerId && targetQboProjectIds!.has(l.customerId)))
    : fetchedBills;

  if (fetchedBills.length === 0) {
    await supabase
      .from("qbo_bill_import_jobs")
      .update({ status: "done", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", job.id);
    return;
  }

  // Reference data resolved once per batch, not once per bill: the
  // account behind every Item (Product/Service), the org's category/class
  // mirrors, and its projects. All small, all already-synced tables.
  const [itemAccounts, { data: categories }, { data: classes }, { data: projects }, { data: suppliers }] =
    await Promise.all([
      listItemAccounts(conn),
      supabase.from("qbo_categories").select("qbo_account_id, name, acct_num").eq("organization_id", organizationId),
      supabase.from("qbo_classes").select("qbo_class_id, name").eq("organization_id", organizationId),
      supabase.from("projects").select("id, qbo_id").eq("organization_id", organizationId).not("qbo_id", "is", null),
      supabase.from("suppliers").select("id, name, qbo_vendor_id").eq("organization_id", organizationId).not("qbo_vendor_id", "is", null),
    ]);

  const categoryByAccountId = new Map(
    (categories ?? []).map((c) => [c.qbo_account_id, categoryDisplayName({ acctNum: c.acct_num, name: c.name })])
  );
  const classNameById = new Map((classes ?? []).map((c) => [c.qbo_class_id, c.name]));
  const projectIdByQboId = new Map((projects ?? []).map((p) => [p.qbo_id as string, p.id]));
  const supplierByVendorId = new Map((suppliers ?? []).map((s) => [s.qbo_vendor_id as string, s]));

  // A line's category resolves through either shape QBO offers, to the
  // exact display string every other line in the system already carries
  // (e.g. "2-1031 - HB Payable") — never a new representation, so
  // detection, the ledger and everything downstream needs no changes.
  const categoryFor = (line: { accountId: string | null; itemId: string | null }): string | null => {
    if (line.accountId) return categoryByAccountId.get(line.accountId) ?? null;
    if (line.itemId) {
      const item = itemAccounts.get(line.itemId);
      if (item?.expenseAccountId) return categoryByAccountId.get(item.expenseAccountId) ?? null;
    }
    return null;
  };

  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const notes: string[] = [];

  for (const bill of bills) {
    try {
      const { data: dup } = await supabase
        .from("invoices")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("qbo_bill_id", bill.id)
        .maybeSingle();
      if (dup) {
        skipped += 1;
        continue;
      }

      const supplier = supplierByVendorId.get(bill.vendorId);
      if (!supplier) {
        skipped += 1;
        notes.push(`Bill ${bill.docNumber ?? bill.id}: vendor not in Flow's supplier list yet.`);
        continue;
      }

      let attachments: { fileName: string; contentType: string; bytes: Uint8Array }[] = [];
      try {
        const listed = await listAttachmentsForBill(conn, bill.id);
        // Fetched immediately, one at a time, right after listing — the
        // download URL is short-lived (Intuit's own community reports
        // ~15 minutes), so nothing here holds onto it.
        for (const a of listed) {
          const bytes = await downloadAttachment(a.downloadUrl);
          attachments.push({ fileName: a.fileName, contentType: a.contentType, bytes });
        }
      } catch {
        attachments = [];
      }

      // A bill with nothing to show is skipped rather than invented a
      // placeholder document for — the whole point of this tool is
      // bringing in the real backup, and a fabricated stand-in document
      // would be worse than leaving that one for the customer to handle
      // by hand.
      if (attachments.length === 0) {
        skipped += 1;
        notes.push(`Bill ${bill.docNumber ?? bill.id}: no attachment in QuickBooks, skipped.`);
        continue;
      }

      const uploaded: { path: string; name: string }[] = [];
      for (const a of attachments) {
        const safeName = a.fileName.replace(/[^\w.-]+/g, "_");
        const path = `${organizationId}/${crypto.randomUUID()}-${safeName}`;
        const { error: uploadError } = await supabase.storage
          .from("invoices")
          .upload(path, a.bytes, { contentType: a.contentType, upsert: false });
        if (!uploadError) uploaded.push({ path, name: a.fileName });
      }
      if (uploaded.length === 0) {
        failed += 1;
        notes.push(`Bill ${bill.docNumber ?? bill.id}: attachment upload failed.`);
        continue;
      }

      // The invoice-level project is set only when every line agrees —
      // a bill split across two jobs has no single "the" project, and
      // guessing one would be worse than leaving it for a human to see
      // and assign per line, same as the line items already carry.
      const lineProjectIds = new Set(
        bill.lines.map((l) => (l.customerId ? projectIdByQboId.get(l.customerId) ?? null : null)).filter(Boolean)
      );
      const invoiceProjectId = lineProjectIds.size === 1 ? [...lineProjectIds][0] : null;

      const { data: invoice, error: invoiceError } = await supabase
        .from("invoices")
        .insert({
          organization_id: organizationId,
          workflow_id: null,
          vendor_name: supplier.name,
          supplier_id: supplier.id,
          invoice_number: bill.docNumber,
          amount: bill.totalAmt,
          document_total: bill.totalAmt,
          tax_amount: bill.totalTax,
          currency: bill.currency,
          bill_date: bill.txnDate,
          due_date: bill.dueDate,
          project_id: invoiceProjectId,
          status: "approved",
          source: "qbo_import",
          file_path: uploaded[0].path,
          file_name: uploaded[0].name,
          qbo_bill_id: bill.id,
          qbo_sync_status: "synced",
          qbo_synced_at: bill.lastUpdatedTime ?? new Date().toISOString(),
        })
        .select("id")
        .single();
      if (invoiceError || !invoice) {
        failed += 1;
        notes.push(`Bill ${bill.docNumber ?? bill.id}: ${invoiceError?.message ?? "insert failed"}.`);
        continue;
      }

      if (uploaded.length > 1) {
        await supabase.from("invoice_documents").insert(
          uploaded.slice(1).map((u) => ({ invoice_id: invoice.id, file_path: u.path, file_name: u.name }))
        );
      }

      await supabase.from("invoice_line_items").insert(
        bill.lines.map((line, i) => ({
          invoice_id: invoice.id,
          description: line.description,
          amount: line.amount,
          category: categoryFor(line),
          class: line.classId ? classNameById.get(line.classId) ?? null : null,
          project_id: line.customerId ? projectIdByQboId.get(line.customerId) ?? null : null,
          line_order: i + 1,
        }))
      );

      // QBO's memo is one flat block of text with no per-author
      // threading — a single system-authored entry, same box the live
      // thread writes to, so it shows in the exact same place.
      if (bill.privateNote) {
        await supabase.from("accounting_instructions").insert({
          invoice_id: invoice.id,
          author_id: null,
          body: bill.privateNote,
        });
      }

      // Best-effort, matching every other write path into this ledger —
      // a sync failure here must never fail the import itself.
      await syncInvoiceRetainage(supabase, organizationId, invoice.id);

      await supabase.from("audit_log").insert({
        organization_id: organizationId,
        invoice_id: invoice.id,
        actor_id: job.created_by,
        action: "invoice.imported_from_qbo",
        metadata: { qbo_bill_id: bill.id, date_from: job.date_from, date_to: job.date_to },
      });

      imported += 1;
    } catch (err) {
      failed += 1;
      notes.push(`Bill ${bill.docNumber ?? bill.id}: ${err instanceof Error ? err.message : "unexpected error"}.`);
    }
  }

  const scanned = fetchedBills.length;
  const pageSize = targetQboProjectIds ? SCAN_PAGE_SIZE : BATCH_SIZE;
  const isLastPage = scanned < pageSize;
  await supabase
    .from("qbo_bill_import_jobs")
    .update({
      cursor_position: job.cursor_position + scanned,
      imported_count: job.imported_count + imported,
      skipped_count: job.skipped_count + skipped,
      failed_count: job.failed_count + failed,
      // Keep the most recent 20 notes — enough to see what needs manual
      // follow-up on a large backlog without the array growing forever.
      notes: [...job.notes, ...notes].slice(-20),
      status: isLastPage ? "done" : "processing",
      completed_at: isLastPage ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id);
}
