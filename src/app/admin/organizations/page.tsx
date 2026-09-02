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
                  {org.trial_ends_at && !org.plan && !custom && (
                    <form action={extendTrialAction}>
                      <input type="hidden" name="org_id" value={org.id} />
                      <input type="hidden" name="days" value="14" />
                      <button type="submit" className={adminGhostBtnCls}>
                        +14 days
                      </button>
                    </form>
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
            </section>
          );
        })}
      </div>
    </div>
  );
}
