import { Fragment } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { createOrganizationAction, joinOrganizationAction, extendTrialAction, setOrgPlanAction, setOrgCustomPlanAction, setOrgSetupFeeAction } from "@/lib/admin-actions";
import { SubmitButton } from "@/components/SubmitButton";
import { DirtySaveButton } from "@/components/DirtySaveButton";
import { isTrialActive, PLAN_ORDER, PLANS, parseCustomPlan, resolveSetupFee } from "@/lib/plans";
import { BackToDashboardButton } from "@/components/BackToDashboardButton";

const adminInputCls =
  "w-full rounded-md border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-600 placeholder:text-slate-400";

const ERRORS: Record<string, string> = {
  "missing-fields": "Organization name and admin email are both required.",
  "bad-inbound-local": "The friendly inbound address can only use lowercase letters, digits, '.', '_' or '-'.",
  "inbound-local-taken": "That inbound address is already used by another organization.",
  "create-failed": "Could not create the organization.",
  "invite-failed": "Organization created, but the admin account could not be created — invite them manually from that org's Settings page.",
  "bad-extend": "Enter a valid number of days to extend the trial by.",
  "bad-plan": "Could not update the plan.",
  "bad-org": "No organization was identified.",
  "bad-custom-plan": "A custom plan needs a name, a monthly price, an included-document count and an overage rate.",
  "bad-setup-fee": "Enter a setup fee between 0 and 1,000,000, or leave it blank to remove it.",
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
  const opsAppUrl = process.env.OPS_APP_URL;

  const { data: orgs } = await admin
    .from("organizations")
    .select("id, name, slug, inbound_email_token, inbound_email_local, trial_ends_at, plan, custom_plan, setup_fee_usd, setup_fee_label, setup_fee_paid_at, created_at")
    .order("created_at", { ascending: false });

  const { data: memberRows } = await admin
    .from("organization_members")
    .select("organization_id, user_id");
  const memberCounts = new Map<string, number>();
  const myOrgIds = new Set<string>();
  for (const row of memberRows ?? []) {
    memberCounts.set(row.organization_id, (memberCounts.get(row.organization_id) ?? 0) + 1);
    if (row.user_id === user.id) myOrgIds.add(row.organization_id);
  }

  const { data: supportRows } = await admin
    .from("support_messages")
    .select("organization_id, created_at")
    .order("created_at", { ascending: false });
  const supportCounts = new Map<string, number>();
  const supportLastAt = new Map<string, string>();
  for (const row of supportRows ?? []) {
    supportCounts.set(row.organization_id, (supportCounts.get(row.organization_id) ?? 0) + 1);
    if (!supportLastAt.has(row.organization_id)) {
      supportLastAt.set(row.organization_id, row.created_at); // first hit = newest, already sorted desc
    }
  }

  const error = searchParams.error ? ERRORS[searchParams.error] ?? "Something went wrong." : null;
  const createdOrg = searchParams.created
    ? (orgs ?? []).find((o) => o.id === searchParams.created)
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-8">
      <div>
        <BackToDashboardButton />
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
              <th className="py-1.5 pr-3">Support</th>
              <th className="py-1.5 pr-3">Plan</th>
              <th className="py-1.5 pr-3">Trial</th>
              <th className="py-1.5 pr-3">Created</th>
              <th className="py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {(orgs ?? []).map((org) => {
              const custom = parseCustomPlan(org.custom_plan);
              const fee = resolveSetupFee(org);
              return (
              // Fragment (not <>) because the map's element is what needs
              // the key, not the rows inside it.
              <Fragment key={org.id}>
              <tr className="border-b border-slate-100">
                <td className="py-1.5 pr-3 font-medium text-slate-700">{org.name}</td>
                <td className="py-1.5 pr-3 font-mono text-xs text-slate-500">
                  {(org.inbound_email_local ?? org.inbound_email_token)}@{domain}
                </td>
                <td className="py-1.5 pr-3 text-slate-500">{memberCounts.get(org.id) ?? 0}</td>
                <td className="py-1.5 pr-3 text-slate-500">
                  {supportCounts.get(org.id) ? (
                    <span>
                      {supportCounts.get(org.id)} msg
                      {supportCounts.get(org.id) === 1 ? "" : "s"} ·{" "}
                      {new Date(supportLastAt.get(org.id)!).toLocaleDateString()}
                    </span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
                <td className="py-1.5 pr-3">
                  <form action={setOrgPlanAction} className="flex items-center gap-1.5">
                    <input type="hidden" name="org_id" value={org.id} />
                    <select
                      name="plan"
                      defaultValue={org.plan ?? ""}
                      className="rounded-md border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-600"
                    >
                      <option value="">No plan</option>
                      {PLAN_ORDER.map((id) => (
                        <option key={id} value={id}>
                          {PLANS[id].name}
                        </option>
                      ))}
                    </select>
                    <DirtySaveButton />
                  </form>
                  {custom && (
                    <span className="mt-1 inline-block rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                      Custom: {custom.name} · ${custom.priceUsd}/mo
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-slate-500">
                  {org.trial_ends_at ? (
                    <span
                      className={isTrialActive(org.trial_ends_at) ? "text-slate-500" : "text-rose-600"}
                    >
                      {isTrialActive(org.trial_ends_at) ? "Trial · " : "Ended · "}
                      {new Date(org.trial_ends_at).toLocaleDateString()}
                    </span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-slate-500">
                  {new Date(org.created_at).toLocaleDateString()}
                </td>
                <td className="py-1.5 text-right">
                  <div className="flex justify-end gap-1.5">
                    {org.trial_ends_at && !org.plan && (
                      <form action={extendTrialAction}>
                        <input type="hidden" name="org_id" value={org.id} />
                        <input type="hidden" name="days" value="14" />
                        <button
                          type="submit"
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                        >
                          +14 days
                        </button>
                      </form>
                    )}
                    <form action={joinOrganizationAction}>
                      <input type="hidden" name="org_id" value={org.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                      >
                        {myOrgIds.has(org.id) ? "View" : "Join as support"}
                      </button>
                    </form>
                    {opsAppUrl && (
                      <Link
                        href={`${opsAppUrl}/support/${org.id}`}
                        target="_blank"
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                      >
                        Support chat
                      </Link>
                    )}
                  </div>
                </td>
              </tr>
              {/* Deal terms live in a collapsed row rather than more
                  columns — the table is already eight wide, and these are
                  edited rarely (once, when a deal is signed). */}
              <tr className="border-b border-slate-100">
                <td colSpan={8} className="pb-3">
                  <details className="rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5">
                    <summary className="cursor-pointer text-xs font-medium text-slate-600">
                      Custom plan &amp; setup fee
                      {custom && <span className="ml-1.5 text-emerald-700">· custom plan set</span>}
                      {fee?.outstanding && <span className="ml-1.5 text-amber-700">· fee due</span>}
                      {fee && !fee.outstanding && <span className="ml-1.5 text-slate-400">· fee paid</span>}
                    </summary>
                    <div className="mt-2 grid gap-4 pb-2 lg:grid-cols-2">
                      <form action={setOrgCustomPlanAction} className="space-y-1.5">
                        <input type="hidden" name="org_id" value={org.id} />
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                          Custom plan
                        </p>
                        <input
                          name="custom_name"
                          defaultValue={custom?.name ?? ""}
                          placeholder="Plan name (blank to remove)"
                          className={adminInputCls}
                        />
                        <div className="grid grid-cols-3 gap-1.5">
                          <input
                            name="custom_price"
                            type="number"
                            min="0"
                            step="1"
                            defaultValue={custom?.priceUsd ?? ""}
                            placeholder="$/mo"
                            className={adminInputCls}
                          />
                          <input
                            name="custom_docs"
                            type="number"
                            min="0"
                            step="1"
                            defaultValue={custom?.includedDocs ?? ""}
                            placeholder="Docs incl."
                            className={adminInputCls}
                          />
                          <input
                            name="custom_overage"
                            type="number"
                            min="0"
                            step="0.01"
                            defaultValue={custom?.overageRatePerDoc ?? ""}
                            placeholder="$/extra doc"
                            className={adminInputCls}
                          />
                        </div>
                        <input
                          name="custom_blurb"
                          defaultValue={custom?.blurb ?? ""}
                          placeholder="What this plan includes (shown to them)"
                          className={adminInputCls}
                        />
                        <div className="flex flex-wrap items-center gap-3 pt-0.5">
                          <label className="flex items-center gap-1.5 text-xs text-slate-600">
                            <input
                              type="checkbox"
                              name="custom_statements"
                              defaultChecked={custom?.statementReconciliation ?? false}
                              className="h-3.5 w-3.5 rounded border-slate-300"
                            />
                            Statement reconciliation
                          </label>
                          <label className="flex items-center gap-1.5 text-xs text-slate-600">
                            Extraction
                            <select
                              name="custom_extraction"
                              defaultValue={custom?.extraction ?? "complex"}
                              className={adminInputCls}
                            >
                              <option value="complex">Complex (line-by-line)</option>
                              <option value="simple">Simple</option>
                            </select>
                          </label>
                          <DirtySaveButton />
                        </div>
                      </form>

                      <form action={setOrgSetupFeeAction} className="space-y-1.5">
                        <input type="hidden" name="org_id" value={org.id} />
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                          One-time setup fee
                        </p>
                        <div className="grid grid-cols-3 gap-1.5">
                          <input
                            name="setup_fee"
                            type="number"
                            min="0"
                            step="1"
                            defaultValue={fee?.amountUsd ?? ""}
                            placeholder="$ (blank to remove)"
                            className={adminInputCls}
                          />
                          <input
                            name="setup_fee_label"
                            defaultValue={org.setup_fee_label ?? ""}
                            placeholder="What it's for"
                            className={`${adminInputCls} col-span-2`}
                          />
                        </div>
                        <div className="flex flex-wrap items-center gap-3 pt-0.5">
                          <label className="flex items-center gap-1.5 text-xs text-slate-600">
                            <input
                              type="checkbox"
                              name="setup_fee_paid"
                              defaultChecked={Boolean(fee && !fee.outstanding)}
                              className="h-3.5 w-3.5 rounded border-slate-300"
                            />
                            Paid
                          </label>
                          <DirtySaveButton />
                        </div>
                        <p className="text-[11px] text-slate-400">
                          {fee?.outstanding
                            ? "Added to their next Stripe payment, and marked paid automatically when it clears. Tick Paid if you invoiced it outside Stripe."
                            : fee
                              ? `Paid ${new Date(fee.paidAt!).toLocaleDateString()}.`
                              : "No fee set — nothing appears on their Billing page."}
                        </p>
                      </form>
                    </div>
                  </details>
                </td>
              </tr>
              </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
