import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { createOrganizationAction, joinOrganizationAction, extendTrialAction, endTrialAction, setOrgPlanAction, setOrgCustomPlanAction, setOrgSetupFeeAction, setOrgInternalAction, startQboBillImportAction } from "@/lib/admin-actions";
import { SubmitButton } from "@/components/SubmitButton";
import { DirtySaveButton } from "@/components/DirtySaveButton";
import { isTrialActive, PLAN_ORDER, PLANS, parseCustomPlan, resolveSetupFee } from "@/lib/plans";
import { BackToDashboardButton } from "@/components/BackToDashboardButton";

const adminFieldCls =
  "w-full rounded-lg border border-brand-line bg-white px-2.5 py-1.5 text-xs text-brand-ink placeholder:text-slate-400 focus:border-brand-green focus:outline-none focus:ring-2 focus:ring-brand-green-light/30";
const adminLabelCls = "mb-1 block text-[11px] font-medium text-brand-muted";
const adminGhostBtnCls =
  "rounded-lg border border-brand-line bg-white px-2.5 py-1.5 text-xs font-medium text-brand-ink transition-colors hover:bg-brand-mist";

// Status chips. Colour carries meaning here — amber is money owed, rose is
// a lapsed trial — so it's a fixed map rather than a free-form class.
const CHIP_TONES = {
  slate: "bg-brand-mist text-brand-muted",
  emerald: "bg-brand-green/15 text-brand-green-dark",
  amber: "bg-amber-100 text-amber-800",
  rose: "bg-rose-100 text-rose-700",
} as const;
const chipCls = (tone: keyof typeof CHIP_TONES) =>
  `rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${CHIP_TONES[tone]}`;

const ERRORS: Record<string, string> = {
  "missing-fields": "Organization name and admin email are both required.",
  "bad-inbound-local": "The friendly inbound address can only use lowercase letters, digits, '.', '_' or '-'.",
  "inbound-local-taken": "That inbound address is already used by another organization.",
  "create-failed": "Could not create the organization.",
  "invite-failed": "Organization created, but the admin account could not be created — invite them manually from that org's Settings page.",
  "bad-extend": "Enter a valid number of days to extend the trial by.",
  "bad-trial-days": "Trial length must be a number of days between 0 and 3650 (0 for no trial).",
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

  const { data: importJobs } = await admin
    .from("qbo_bill_import_jobs")
    .select("*")
    .order("created_at", { ascending: false });
  const { data: qboConnections } = await admin.from("qbo_connections").select("organization_id");
  const orgsWithQbo = new Set((qboConnections ?? []).map((c) => c.organization_id));

  // For the "only this project" scope on the import form below — every
  // org's QBO-synced projects, small enough to fetch up front rather
  // than per-row.
  const { data: allProjects } = await admin
    .from("projects")
    .select("id, organization_id, name")
    .eq("source", "qbo")
    .eq("active", true)
    .order("name");
  const projectsByOrg = new Map<string, { id: string; name: string }[]>();
  for (const p of allProjects ?? []) {
    const list = projectsByOrg.get(p.organization_id) ?? [];
    list.push({ id: p.id, name: p.name });
    projectsByOrg.set(p.organization_id, list);
  }
  const latestImportJobByOrg = new Map<string, NonNullable<typeof importJobs>[number]>();
  for (const j of importJobs ?? []) {
    if (!latestImportJobByOrg.has(j.organization_id)) latestImportJobByOrg.set(j.organization_id, j);
  }

  const { data: orgs } = await admin
    .from("organizations")
    .select("id, name, slug, inbound_email_token, inbound_email_local, trial_ends_at, plan, custom_plan, is_internal, setup_fee_usd, setup_fee_label, setup_fee_paid_at, created_at")
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
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <div>
        <BackToDashboardButton />
        <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-brand-green-dark">
          Platform admin
        </p>
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-brand-ink">
          Organizations
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-brand-muted">
          Every tenant on Flow. Creating one inserts the organization, generates its inbound
          invoice address, and creates its first admin account — that admin signs in at{" "}
          <span className="font-mono text-brand-ink">/login</span> with a one-time link.
        </p>
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {createdOrg && (
        <div className="rounded-lg border border-brand-green-light/40 bg-brand-mist px-4 py-3 text-sm text-brand-green-dark">
          <p className="font-display font-bold">&quot;{createdOrg.name}&quot; created.</p>
          <p className="mt-1">
            Invoice address:{" "}
            <span className="font-mono text-brand-ink">
              {createdOrg.inbound_email_local ?? createdOrg.inbound_email_token}@{domain}
            </span>
          </p>
          <p className="mt-1">
            Tell their admin to go to <span className="font-mono">/login</span>, choose
            &quot;one-time link&quot;, and enter the email you just invited.
          </p>
        </div>
      )}

      {/* Create — collapsed by default. It's the rarest action on the page
          (a handful of times ever), and open it pushed the actual list,
          which is what this page is for, below the fold. */}
      <details className="group rounded-xl border border-brand-line bg-white shadow-elevation-1 shadow-brand-ink/5">
        <summary className="flex cursor-pointer items-center justify-between px-5 py-3.5">
          <span className="font-display text-sm font-bold text-brand-ink">
            Create organization
          </span>
          <span className="text-xs font-medium text-brand-muted group-open:hidden">Open</span>
          <span className="hidden text-xs font-medium text-brand-muted group-open:inline">Close</span>
        </summary>
        <form action={createOrganizationAction} className="space-y-4 border-t border-brand-line px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={adminLabelCls}>Organization name</label>
              <input name="org_name" required placeholder="Fluid Construction" className={adminFieldCls} />
            </div>
            <div>
              <label className={adminLabelCls}>Friendly inbound address (optional)</label>
              <div className="flex items-center gap-2">
                <input name="inbound_local" placeholder="fluid" className={adminFieldCls} />
                <span className="whitespace-nowrap text-xs text-brand-muted">@{domain}</span>
              </div>
            </div>
            <div>
              <label className={adminLabelCls}>First admin&apos;s email</label>
              <input
                name="admin_email"
                type="email"
                required
                placeholder="owner@fluidconstruction.ca"
                className={adminFieldCls}
              />
            </div>
            <div>
              <label className={adminLabelCls}>Their name (optional)</label>
              <input name="admin_name" placeholder="Jane Doe" className={adminFieldCls} />
            </div>
            <div>
              <label className={adminLabelCls}>Trial length (days)</label>
              <input
                name="trial_days"
                type="number"
                min="0"
                max="3650"
                defaultValue="14"
                className={adminFieldCls}
              />
              <p className="mt-1 text-[11px] text-brand-muted">
                14 is the rule. 0 gives them no trial clock at all.
              </p>
            </div>
          </div>
          <p className="text-xs text-brand-muted">
            Leave the inbound address blank for a random token address — the org&apos;s own
            admin can set it later from Settings.
          </p>
          <SubmitButton className="rounded-lg bg-brand-green px-4 py-2 text-sm font-display font-bold text-white hover:bg-brand-green-dark">
            Create organization
          </SubmitButton>
        </form>
      </details>

      <div className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
          {(orgs ?? []).length} organization{(orgs ?? []).length === 1 ? "" : "s"}
        </h2>

        {/* One card per org rather than a wide table: the fields here are
            heterogeneous (an address, a count, a select, three forms), and
            a table forced all of them into columns sized by the widest
            cell. A card lets each org's identity lead and pushes the
            rarely-touched deal terms into a fold. */}
        {(orgs ?? []).map((org) => {
          const custom = parseCustomPlan(org.custom_plan);
          const importJob = latestImportJobByOrg.get(org.id);
          const orgProjects = projectsByOrg.get(org.id) ?? [];
          const fee = resolveSetupFee(org);
          const members = memberCounts.get(org.id) ?? 0;
          const supportCount = supportCounts.get(org.id) ?? 0;
          const trialing = org.trial_ends_at != null && isTrialActive(org.trial_ends_at);
          const trialEnded = org.trial_ends_at != null && !trialing;

          return (
            <section
              key={org.id}
              className="rounded-xl border border-brand-line bg-white shadow-elevation-1 shadow-brand-ink/5"
            >
              <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-display text-base font-extrabold text-brand-ink">
                      {org.name}
                    </h3>
                    {org.is_internal && <span className={chipCls("emerald")}>Internal</span>}
                    {custom ? (
                      <span className={chipCls("emerald")}>Custom · ${custom.priceUsd}/mo</span>
                    ) : org.plan ? (
                      <span className={chipCls("slate")}>{PLANS[org.plan].name}</span>
                    ) : (
                      <span className={chipCls("slate")}>No plan</span>
                    )}
                    {trialing && (
                      <span className={chipCls("slate")}>
                        Trial to {new Date(org.trial_ends_at!).toLocaleDateString()}
                      </span>
                    )}
                    {trialEnded && !org.plan && !custom && (
                      <span className={chipCls("rose")}>Trial ended</span>
                    )}
                    {fee?.outstanding && (
                      <span className={chipCls("amber")}>
                        Fee due ${fee.amountUsd.toLocaleString()}
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 truncate font-mono text-xs text-brand-muted">
                    {(org.inbound_email_local ?? org.inbound_email_token)}@{domain}
                  </p>
                  <p className="mt-1 text-xs text-brand-muted">
                    {members} member{members === 1 ? "" : "s"}
                    {" · created "}
                    {new Date(org.created_at).toLocaleDateString()}
                    {supportCount > 0 && (
                      <>
                        {" · "}
                        <span className="font-medium text-brand-ink">
                          {supportCount} support msg{supportCount === 1 ? "" : "s"}
                        </span>
                        {" · "}
                        {new Date(supportLastAt.get(org.id)!).toLocaleDateString()}
                      </>
                    )}
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <form action={setOrgPlanAction} className="flex items-center gap-1.5">
                    <input type="hidden" name="org_id" value={org.id} />
                    <select
                      name="plan"
                      defaultValue={org.plan ?? ""}
                      title={custom ? "Overridden by this org's custom plan" : undefined}
                      className={`rounded-lg border border-brand-line bg-white px-2 py-1.5 text-xs text-brand-ink ${
                        custom ? "opacity-50" : ""
                      }`}
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
                  {/* Trial controls. Shown while the org has no plan of its
                      own — once they're paying, the trial clock is moot.
                      extendTrialAction doubles as "start": with no trial
                      set it bases off today. */}
                  {!org.plan && !custom && !org.is_internal && (
                    <>
                      <form action={extendTrialAction} className="flex items-center gap-1">
                        <input type="hidden" name="org_id" value={org.id} />
                        <input
                          name="days"
                          type="number"
                          min="1"
                          max="3650"
                          defaultValue={14}
                          aria-label="Days to extend the trial by"
                          className="w-14 rounded-lg border border-brand-line bg-white px-2 py-1.5 text-xs tabular-nums text-brand-ink"
                        />
                        <button type="submit" className={adminGhostBtnCls}>
                          {org.trial_ends_at ? "Extend" : "Start trial"}
                        </button>
                      </form>
                      {trialing && (
                        <form action={endTrialAction}>
                          <input type="hidden" name="org_id" value={org.id} />
                          <button
                            type="submit"
                            className="rounded-lg border border-rose-200 bg-white px-2.5 py-1.5 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-50"
                          >
                            End trial
                          </button>
                        </form>
                      )}
                    </>
                  )}
                  <form action={joinOrganizationAction}>
                    <input type="hidden" name="org_id" value={org.id} />
                    <button type="submit" className={adminGhostBtnCls}>
                      {myOrgIds.has(org.id) ? "View" : "Join as support"}
                    </button>
                  </form>
                  {opsAppUrl && (
                    <Link
                      href={`${opsAppUrl}/support/${org.id}`}
                      target="_blank"
                      className={adminGhostBtnCls}
                    >
                      Support chat
                    </Link>
                  )}
                </div>
              </div>

              {/* Deal terms: folded away because they're set once, when a
                  deal is signed, and never touched again. */}
              <details className="border-t border-brand-line">
                <summary className="cursor-pointer px-5 py-2.5 text-xs font-medium text-brand-muted hover:bg-brand-mist">
                  Custom plan &amp; setup fee
                  {custom && <span className="ml-1.5 text-brand-green-dark">· custom plan set</span>}
                  {fee?.outstanding && <span className="ml-1.5 text-amber-700">· fee due</span>}
                  {fee && !fee.outstanding && <span className="ml-1.5 text-brand-muted">· fee paid</span>}
                </summary>
                <div className="grid gap-5 border-t border-brand-line bg-brand-mist px-5 py-4 lg:grid-cols-2">
                  <form action={setOrgCustomPlanAction} className="space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
                      Custom plan
                    </p>
                    <input type="hidden" name="org_id" value={org.id} />
                    <div>
                      <label className={adminLabelCls}>Plan name</label>
                      <input
                        name="custom_name"
                        defaultValue={custom?.name ?? ""}
                        placeholder="Blank to remove the custom plan"
                        className={adminFieldCls}
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className={adminLabelCls}>USD / month</label>
                        <input
                          name="custom_price"
                          type="number"
                          min="0"
                          step="1"
                          defaultValue={custom?.priceUsd ?? ""}
                          placeholder="450"
                          className={adminFieldCls}
                        />
                      </div>
                      <div>
                        <label className={adminLabelCls}>Docs included</label>
                        <input
                          name="custom_docs"
                          type="number"
                          min="0"
                          step="1"
                          defaultValue={custom?.includedDocs ?? ""}
                          placeholder="1500"
                          className={adminFieldCls}
                        />
                      </div>
                      <div>
                        <label className={adminLabelCls}>USD / extra doc</label>
                        <input
                          name="custom_overage"
                          type="number"
                          min="0"
                          step="0.01"
                          defaultValue={custom?.overageRatePerDoc ?? ""}
                          placeholder="0.15"
                          className={adminFieldCls}
                        />
                      </div>
                    </div>
                    <div>
                      <label className={adminLabelCls}>What it includes (they see this)</label>
                      <input
                        name="custom_blurb"
                        defaultValue={custom?.blurb ?? ""}
                        placeholder="Built around your approval process."
                        className={adminFieldCls}
                      />
                    </div>
                    <div className="flex flex-wrap items-end gap-4 pt-1">
                      <label className="flex items-center gap-1.5 text-xs text-brand-ink">
                        <input
                          type="checkbox"
                          name="custom_statements"
                          defaultChecked={custom?.statementReconciliation ?? false}
                          className="h-3.5 w-3.5 rounded border-brand-line"
                        />
                        Statement reconciliation
                      </label>
                      <div>
                        <label className={adminLabelCls}>Extraction</label>
                        <select
                          name="custom_extraction"
                          defaultValue={custom?.extraction ?? "complex"}
                          className={adminFieldCls}
                        >
                          <option value="complex">Complex (line-by-line)</option>
                          <option value="simple">Simple</option>
                        </select>
                      </div>
                      <DirtySaveButton />
                    </div>
                  </form>

                  <form action={setOrgInternalAction} className="lg:col-span-2">
                    <input type="hidden" name="org_id" value={org.id} />
                    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand-line bg-white px-3 py-2">
                      <label className="flex items-center gap-2 text-xs text-brand-ink">
                        <input
                          type="checkbox"
                          name="is_internal"
                          defaultChecked={org.is_internal}
                          className="h-3.5 w-3.5 rounded border-brand-line"
                        />
                        <span className="font-medium">House account</span>
                      </label>
                      <span className="flex-1 text-[11px] text-brand-muted">
                        Full access to everything, never billed, never trial-locked. All
                        payment UI disappears from their Billing page.
                      </span>
                      <DirtySaveButton />
                    </div>
                  </form>

                  <form action={setOrgSetupFeeAction} className="space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
                      One-time setup fee
                    </p>
                    <input type="hidden" name="org_id" value={org.id} />
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className={adminLabelCls}>USD</label>
                        <input
                          name="setup_fee"
                          type="number"
                          min="0"
                          step="1"
                          defaultValue={fee?.amountUsd ?? ""}
                          placeholder="Blank to remove"
                          className={adminFieldCls}
                        />
                      </div>
                      <div className="col-span-2">
                        <label className={adminLabelCls}>What it&apos;s for</label>
                        <input
                          name="setup_fee_label"
                          defaultValue={org.setup_fee_label ?? ""}
                          placeholder="Custom build &amp; onboarding"
                          className={adminFieldCls}
                        />
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-4 pt-1">
                      <label className="flex items-center gap-1.5 text-xs text-brand-ink">
                        <input
                          type="checkbox"
                          name="setup_fee_paid"
                          defaultChecked={Boolean(fee && !fee.outstanding)}
                          className="h-3.5 w-3.5 rounded border-brand-line"
                        />
                        Paid
                      </label>
                      <DirtySaveButton />
                    </div>
                    <p className="text-[11px] leading-relaxed text-brand-muted">
                      {fee?.outstanding
                        ? "Added to their next Stripe payment and marked paid automatically when it clears. Tick Paid if you invoiced it outside Stripe."
                        : fee
                          ? `Paid ${new Date(fee.paidAt!).toLocaleDateString()}.`
                          : "No fee set — nothing appears on their Billing page."}
                    </p>
                  </form>
                </div>
              </details>

              {/* Historical QuickBooks import — Araza's own tool, run by
                  hand when onboarding a paying customer who wants their
                  pre-Flow bills brought in with backup. Never surfaced to
                  the customer's own admin: this table has no RLS policy
                  for any role but the service key (migration 0104), and
                  this action redirects anyone who isn't a platform admin
                  straight to /login. Charged as its own line item, not a
                  feature of the base product. */}
              <details className="border-t border-brand-line">
                <summary className="cursor-pointer px-5 py-2.5 text-xs font-medium text-brand-muted hover:bg-brand-mist">
                  Import bills from QuickBooks (owner tool)
                  {importJob?.project_id && (
                    <span className="ml-1.5 text-brand-muted">
                      · scoped to {orgProjects.find((p) => p.id === importJob.project_id)?.name ?? "one job"}
                    </span>
                  )}
                  {importJob?.status === "processing" && (
                    <span className="ml-1.5 text-brand-navy">
                      · running — {importJob.imported_count} imported so far
                    </span>
                  )}
                  {importJob?.status === "queued" && (
                    <span className="ml-1.5 text-brand-navy">· queued</span>
                  )}
                  {importJob?.status === "done" && (
                    <span className="ml-1.5 text-brand-green-dark">
                      · last run: {importJob.imported_count} imported, {importJob.skipped_count} skipped,{" "}
                      {importJob.failed_count} failed
                    </span>
                  )}
                  {importJob?.status === "error" && (
                    <span className="ml-1.5 text-rose-700">· last run failed</span>
                  )}
                </summary>
                <div className="border-t border-brand-line bg-brand-mist px-5 py-4">
                  <p className="text-[11px] leading-relaxed text-brand-muted">
                    Pulls bills from QuickBooks in the date range below, with their real line
                    items, memo (the same box the live app writes accounting instructions to),
                    and attachments. Every imported bill is written already marked as synced to
                    QuickBooks — Flow will never try to push it back and create a duplicate.
                    Runs in the background over a few minutes; refresh this page for progress.
                  </p>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-brand-muted">
                    Picking a job below imports only bills that touch it — useful for a job
                    that&apos;s been running for years, where you don&apos;t want everything
                    from that whole period. QuickBooks can&apos;t filter by job on its own
                    end, so the date range still has to be wide enough to cover it; scoping
                    just decides what actually comes in out of that range.
                  </p>
                  {!orgsWithQbo.has(org.id) && (
                    <p className="mt-2 text-[11px] font-medium text-amber-700">
                      This org has no QuickBooks connection yet — connect it from their own
                      Settings before running an import.
                    </p>
                  )}
                  <form action={startQboBillImportAction} className="mt-3 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="org_id" value={org.id} />
                    <div>
                      <label className={adminLabelCls}>From</label>
                      <input name="date_from" type="date" required className={adminFieldCls} />
                    </div>
                    <div>
                      <label className={adminLabelCls}>To</label>
                      <input name="date_to" type="date" required className={adminFieldCls} />
                    </div>
                    <div className="min-w-[14rem]">
                      <label className={adminLabelCls}>Only this job (optional)</label>
                      <select name="project_id" defaultValue="" className={adminFieldCls}>
                        <option value="">Every bill in the date range</option>
                        {orgProjects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <SubmitButton
                      disabled={importJob?.status === "queued" || importJob?.status === "processing"}
                      className="rounded-lg bg-brand-navy px-3 py-1.5 text-xs font-display font-bold text-white hover:bg-brand-ink disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {importJob?.status === "processing" || importJob?.status === "queued"
                        ? "Import running…"
                        : "Start import"}
                    </SubmitButton>
                  </form>
                  {importJob && importJob.notes.length > 0 && (
                    <div className="mt-3 rounded-lg border border-brand-line bg-white p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">
                        Needs a look
                      </p>
                      <ul className="mt-1 space-y-0.5 text-[11px] text-brand-muted">
                        {importJob.notes.map((n: string, i: number) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {importJob?.last_error && (
                    <p className="mt-2 text-[11px] text-rose-700">{importJob.last_error}</p>
                  )}
                </div>
              </details>
            </section>
          );
        })}
      </div>
    </div>
  );
}
