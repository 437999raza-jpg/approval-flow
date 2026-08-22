import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { createInvoiceFromFile, InvoiceIngestError } from "@/lib/invoices";
import { extractPdfPageRange, renderPdfPagesToPngDataUrls } from "@/lib/invoice-split";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { SubmitButton } from "@/components/SubmitButton";

const INVOICE_BUCKET = "invoices";

// Confirms a detected split: carves each group's pages out of the
// original upload into its own PDF and runs it through the normal
// single-invoice pipeline (extraction, supplier defaults, workflow
// routing — unchanged). Best-effort per group: one group failing doesn't
// block the others: the invoice belongs in the review queue for a human
// to sort out. Authored by Araza.
async function confirmSplit(pendingSplitId: string) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: pending } = await supabase
    .from("pending_invoice_splits")
    .select("*")
    .eq("id", pendingSplitId)
    .single();
  if (!pending || pending.status !== "pending") return;

  const { data: blob, error: downloadError } = await supabase.storage
    .from(INVOICE_BUCKET)
    .download(pending.file_path);
  if (downloadError || !blob) return;
  const bytes = new Uint8Array(await blob.arrayBuffer());

  const createdIds: string[] = [];
  const errors: string[] = [];
  for (const [i, group] of pending.groups.entries()) {
    try {
      const pageBytes = extractPdfPageRange(bytes, group.pages);
      const groupName = `${pending.file_name.replace(/\.pdf$/i, "")}-part${i + 1}.pdf`;
      const file = new File([pageBytes as BlobPart], groupName, { type: "application/pdf" });
      const invoice = await createInvoiceFromFile({
        supabase,
        organizationId: pending.organization_id,
        file,
        source: pending.source,
        submittedBy: pending.submitted_by ?? undefined,
        sourceEmail: pending.source_email ?? undefined,
      });
      createdIds.push(invoice.id);
    } catch (err) {
      errors.push(err instanceof InvoiceIngestError ? err.message : "Unknown ingest error");
    }
  }

  await supabase
    .from("pending_invoice_splits")
    .update({ status: "confirmed", resolved_at: new Date().toISOString(), resolved_by: user.id })
    .eq("id", pendingSplitId);

  // The original combined upload is no longer needed once each group has
  // its own document from createInvoiceFromFile.
  await supabase.storage.from(INVOICE_BUCKET).remove([pending.file_path]);

  revalidatePath("/dashboard", "layout");
  revalidatePath("/invoices/pending-splits", "layout");
  redirect(
    createdIds.length > 0
      ? `/dashboard/${createdIds[0]}`
      : `/invoices/pending-splits?error=${encodeURIComponent(errors.join("; ") || "Could not create any invoices from this split.")}`
  );
}

async function dismissSplit(pendingSplitId: string) {
  "use server";

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: pending } = await supabase
    .from("pending_invoice_splits")
    .select("file_path, status")
    .eq("id", pendingSplitId)
    .single();
  if (!pending || pending.status !== "pending") return;

  await supabase
    .from("pending_invoice_splits")
    .update({ status: "dismissed", resolved_at: new Date().toISOString(), resolved_by: user.id })
    .eq("id", pendingSplitId);
  await supabase.storage.from(INVOICE_BUCKET).remove([pending.file_path]);

  revalidatePath("/invoices/pending-splits", "layout");
  redirect("/invoices/pending-splits");
}

export default async function PendingSplitReviewPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  if (!org) notFound();

  const { data: pending } = await supabase
    .from("pending_invoice_splits")
    .select("*")
    .eq("id", params.id)
    .single();
  if (!pending) notFound();

  const { data: blob } = await supabase.storage
    .from(INVOICE_BUCKET)
    .download(pending.file_path);
  const thumbnails = blob
    ? renderPdfPagesToPngDataUrls(new Uint8Array(await blob.arrayBuffer())).images
    : [];

  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href="/invoices/pending-splits" className="text-sm text-slate-500 hover:underline">
        ← Back to pending splits
      </Link>
      <h1 className="mt-2 text-xl font-semibold">Review multi-invoice upload</h1>
      <p className="mt-1 text-sm text-slate-500">
        <strong>{pending.file_name}</strong> looks like it contains{" "}
        <strong>{pending.groups.length} separate invoices</strong> across{" "}
        {pending.page_count} page{pending.page_count === 1 ? "" : "s"}. Confirm the split below
        to create {pending.groups.length} invoice{pending.groups.length === 1 ? "" : "s"}, or
        dismiss it and upload the pages separately if this looks wrong.
      </p>

      {pending.status !== "pending" && (
        <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          This upload was already {pending.status} on{" "}
          {pending.resolved_at ? new Date(pending.resolved_at).toLocaleString() : "—"}.
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {pending.groups.map((group, i) => {
          const firstPage = group.pages[0];
          const thumb = firstPage ? thumbnails[firstPage - 1] : undefined;
          const pageLabel =
            group.pages.length === 1
              ? `Page ${group.pages[0]}`
              : `Pages ${group.pages[0]}–${group.pages[group.pages.length - 1]}`;
          return (
            <div key={i} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              {thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumb} alt={`Group ${i + 1} preview`} className="h-48 w-full border-b border-slate-100 object-cover object-top" />
              ) : (
                <div className="flex h-48 w-full items-center justify-center border-b border-slate-100 bg-slate-50 text-xs text-slate-400">
                  No preview
                </div>
              )}
              <div className="p-3">
                <p className="text-sm font-medium text-slate-800">
                  Invoice {i + 1} — {pageLabel}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {group.vendorHint ?? "Vendor unknown"}
                  {group.invoiceNumberHint ? ` · #${group.invoiceNumberHint}` : ""}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {pending.status === "pending" && (
        <div className="mt-6 flex items-center gap-3">
          <form action={confirmSplit.bind(null, pending.id)}>
            <SubmitButton className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
              Confirm split — create {pending.groups.length} invoices
            </SubmitButton>
          </form>
          <ConfirmSubmitButton
            action={dismissSplit.bind(null, pending.id)}
            confirmMessage="Dismiss this split? The upload will be discarded — you can re-upload the pages separately (e.g. one at a time) if this grouping looks wrong."
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Dismiss
          </ConfirmSubmitButton>
        </div>
      )}
    </main>
  );
}
