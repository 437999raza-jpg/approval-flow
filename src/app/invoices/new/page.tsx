import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { InvoiceUploadDropzone } from "@/components/InvoiceUploadDropzone";

export default async function NewInvoicePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const org = await getCurrentOrg(supabase);
  // Auditors are read-only everywhere — the upload API/RLS already reject
  // this, but redirect before they even see the form.
  if (org?.role === "auditor") redirect("/dashboard");

  return (
    <main className="mx-auto max-w-2xl p-8">
      <Link href="/dashboard" className="text-sm text-slate-500 hover:underline">
        ← Back to dashboard
      </Link>
      <h1 className="mt-2 text-xl font-semibold">Add invoice</h1>
      <p className="mt-1 text-sm text-slate-500">
        Uploads land as a new invoice in the &quot;Pending&quot; status and enter the
        default approval workflow.
      </p>
      <div className="mt-6">
        <InvoiceUploadDropzone />
      </div>
    </main>
  );
}
