import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { createOrganizationAction } from "@/lib/admin-actions";
import { SubmitButton } from "@/components/SubmitButton";

const ERRORS: Record<string, string> = {
  "missing-fields": "Organization name and admin email are both required.",
  "bad-inbound-local": "The friendly inbound address can only use lowercase letters, digits, '.', '_' or '-'.",
  "inbound-local-taken": "That inbound address is already used by another organization.",
  "create-failed": "Could not create the organization.",
  "invite-failed": "Organization created, but the admin account could not be created — invite them manually from that org's Settings page.",
};

export default async function AdminOrganizationsPage({
  searchParams,
}: {
  searchParams: { error?: string; created?: string };
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!isPlatformAdmin(user.email)) redirect("/dashboard");

  const admin = createAdminClient();
  const domain = process.env.INBOUND_EMAIL_DOMAIN ?? "invoices.example.com";

  const { data: orgs } = await admin
    .from("organizations")
    .select("id, name, slug, inbound_email_token, inbound_email_local, created_at")
    .order("created_at", { ascending: false });

  const { data: memberRows } = await admin
    .from("organization_members")
    .select("organization_id");
  const memberCounts = new Map<string, number>();
  for (const row of memberRows ?? []) {
    memberCounts.set(row.organization_id, (memberCounts.get(row.organization_id) ?? 0) + 1);
  }

  const error = searchParams.error ? ERRORS[searchParams.error] ?? "Something went wrong." : null;
  const createdOrg = searchParams.created
    ? (orgs ?? []).find((o) => o.id === searchParams.created)
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-8">
      <div>
        <Link href="/dashboard" className="text-sm text-blue-600 hover:underline">
          ← Back to dashboard
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-slate-800">Organizations (platform admin)</h1>
        <p className="mt-1 text-sm text-slate-500">
          Create a new tenant. This inserts the organization, generates its inbound invoice
          address, and creates its first admin account — that admin signs in at{" "}
          <span className="font-mono">/login</span> using a one-time magic link sent to their
          email.
        </p>
      </div>

      {error && (
        <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
      )}
      {createdOrg && (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <p className="font-medium">&quot;{createdOrg.name}&quot; created.</p>
          <p className="mt-1">
            Invoice address:{" "}
            <span className="font-mono">
              {createdOrg.inbound_email_local ?? createdOrg.inbound_email_token}@{domain}
            </span>
          </p>
          <p className="mt-1">
            Tell their admin to go to <span className="font-mono">/login</span>, choose
            &quot;one-time link&quot;, and enter the email you just invited.
          </p>
        </div>
      )}

      <form action={createOrganizationAction} className="space-y-4 rounded-lg border border-slate-200 p-5">
        <h2 className="text-sm font-semibold text-slate-700">Create organization</h2>
        <div>
          <label className="block text-xs font-medium text-slate-500">Organization name</label>
          <input
            name="org_name"
            required
            placeholder="Fluid Construction"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500">Friendly inbound address (optional)</label>
          <div className="mt-1 flex items-center gap-2">
            <input
              name="inbound_local"
              placeholder="fluid"
              className="w-56 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            />
            <span className="text-sm text-slate-400">@{domain}</span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Leave blank to use a random token address — the org&apos;s own admin can set this
            later from Settings.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-500">First admin&apos;s email</label>
            <input
              name="admin_email"
              type="email"
              required
              placeholder="owner@fluidconstruction.ca"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500">Their name (optional)</label>
            <input
              name="admin_name"
              placeholder="Jane Doe"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>
        <SubmitButton className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          Create organization
        </SubmitButton>
      </form>

      <div>
        <h2 className="text-sm font-semibold text-slate-700">Existing organizations</h2>
        <table className="mt-2 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <th className="py-1.5 pr-3">Name</th>
              <th className="py-1.5 pr-3">Invoice address</th>
              <th className="py-1.5 pr-3">Members</th>
              <th className="py-1.5">Created</th>
            </tr>
          </thead>
          <tbody>
            {(orgs ?? []).map((org) => (
              <tr key={org.id} className="border-b border-slate-100">
                <td className="py-1.5 pr-3 font-medium text-slate-700">{org.name}</td>
                <td className="py-1.5 pr-3 font-mono text-xs text-slate-500">
                  {(org.inbound_email_local ?? org.inbound_email_token)}@{domain}
                </td>
                <td className="py-1.5 pr-3 text-slate-500">{memberCounts.get(org.id) ?? 0}</td>
                <td className="py-1.5 text-slate-500">
                  {new Date(org.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
