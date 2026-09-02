"use server";

// Phase 2: the two server-side reads the Dashboard's client component
// calls directly as React Query queryFns (no separate REST layer —
// Server Actions work fine as callable RPCs for reads too, not just
// mutations). This file is deliberately just DATA FETCHING: every
// business rule (who can see what, who's eligible to approve, duplicate
// detection) stays in dashboard-computations.ts as plain, pure functions
// ported unchanged from the original page — this file only gathers the
// raw rows those functions need.
//
// Split into two calls, matching the old page's two-tier shape:
//  - fetchDashboardListData: everything the LIST/filters/sidebar counts
//    need. Fetched once per org per session (React Query caches it),
//    not on every click — this is what used to get silently re-fetched
//    in full on every single invoice navigation.
//  - fetchInvoiceDetail: one invoice's approvals/comments/line items/
//    documents/audit log/instructions. Fetched per-id, cached per-id, so
//    revisiting an already-opened invoice is instant.

import { createClient } from "@/lib/supabase/server";
import { getCurrentOrg } from "@/lib/current-org";
import { redirect } from "next/navigation";
import {
  getCachedQboCategories,
  getCachedQboSuppliers,
  getCachedQboClasses,
  getCachedQboTaxRates,
  getCachedQboTaxCodes,
  getCachedMemberRoster,
  getInvoiceListUncached,
} from "@/lib/org-cache";
import { normalizeForMatching } from "@/lib/matching";
import { isPdfName, isImageName } from "@/lib/file-types";
import type { DocumentRef } from "@/components/DetailSplit";
import type { SupplierDefaultsValues } from "@/components/SupplierRulesModal";

async function requireOrg() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const org = await getCurrentOrg(supabase);
  if (!org) redirect("/dashboard-no-org");
  return { supabase, user, org };
}

export async function fetchDashboardListData() {
  const { supabase, user, org } = await requireOrg();

  const [
    { data: trialOrgRow },
    { data: myMemberships },
    { data: qboConnection },
    { memberUserIds, profileRows },
    { data: memberRoleRows },
    { data: workflows },
    { data: projects },
    qboCategoryRows,
    qboSupplierRows,
    qboClassRows,
    qboTaxRateRows,
    qboTaxCodeRows,
    pendingSplitsRes,
    unreadNotificationsRes,
    { invoices, approvedPairs, lineItemRows },
  ] = await Promise.all([
    supabase.from("organizations").select("plan, custom_plan, is_internal, trial_ends_at").eq("id", org.id).single(),
    supabase.from("organization_members").select("organization_id").eq("user_id", user.id),
    supabase
      .from("qbo_connections")
      .select("realm_id, company_name")
      .eq("organization_id", org.id)
      .maybeSingle(),
    getCachedMemberRoster(org.id),
    supabase.from("organization_members").select("user_id, role").eq("organization_id", org.id),
    supabase.from("approval_workflows").select("id").eq("organization_id", org.id),
    supabase
      .from("projects")
      .select("id, name")
      .eq("organization_id", org.id)
      .eq("active", true)
      .order("name", { ascending: true }),
    getCachedQboCategories(org.id),
    getCachedQboSuppliers(org.id),
    getCachedQboClasses(org.id),
    getCachedQboTaxRates(org.id),
    getCachedQboTaxCodes(org.id),
    supabase
      .from("pending_invoice_splits")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org.id)
      .eq("status", "pending"),
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("read", false),
    getInvoiceListUncached(org.id),
  ]);

  const myOrgIds = (myMemberships ?? []).map((m) => m.organization_id);
  let myOrgs: { id: string; name: string }[] = [];
  if (myOrgIds.length > 1) {
    const { data } = await supabase
      .from("organizations")
      .select("id, name")
      .in("id", myOrgIds)
      .order("name");
    myOrgs = data ?? [];
  }

  const workflowIds = (workflows ?? []).map((w) => w.id);

  const { data: allSteps } =
    workflowIds.length > 0
      ? await supabase
          .from("approval_workflow_steps")
          .select("*")
          .in("workflow_id", workflowIds)
          .order("step_order", { ascending: true })
      : { data: [] };
  const stepIds = (allSteps ?? []).map((s) => s.id);

  const { data: allStepApprovers } =
    stepIds.length > 0
      ? await supabase
          .from("approval_workflow_step_approvers")
          .select("*")
          .in("step_id", stepIds)
          .order("row_order", { ascending: true })
      : { data: [] };

  const stepApproverIds = (allStepApprovers ?? []).map((a) => a.id);
  const { data: allStepConditions } =
    stepApproverIds.length > 0
      ? await supabase
          .from("approval_workflow_step_conditions")
          .select("*")
          .in("step_approver_id", stepApproverIds)
      : { data: [] };

  const memberNameById: Record<string, string> = {};
  for (const p of profileRows ?? []) memberNameById[p.id] = p.full_name ?? "Team member";

  return {
    org,
    user: { id: user.id, email: user.email ?? null },
    trialPlan: trialOrgRow?.plan ?? null,
    trialCustomPlan: trialOrgRow?.custom_plan ?? null,
    trialIsInternal: trialOrgRow?.is_internal ?? false,
    trialEndsAt: trialOrgRow?.trial_ends_at ?? null,
    myOrgs,
    qboConnected: !!qboConnection,
    memberUserIds,
    memberNameById,
    projects: projects ?? [],
    qboCategoryRows: qboCategoryRows ?? [],
    qboSupplierRows: qboSupplierRows ?? [],
    qboClassRows: qboClassRows ?? [],
    qboTaxRateRows: qboTaxRateRows ?? [],
    qboTaxCodeRows: qboTaxCodeRows ?? [],
    pendingSplitsCount: pendingSplitsRes.count ?? 0,
    unreadNotificationsCount: unreadNotificationsRes.count ?? 0,
    invoices: invoices ?? [],
    approvedPairs: approvedPairs ?? [],
    lineItemRows: lineItemRows ?? [],
    allSteps: allSteps ?? [],
    allStepApprovers: allStepApprovers ?? [],
    allStepConditions: allStepConditions ?? [],
    adminUserIds: (memberRoleRows ?? []).filter((m) => m.role === "admin").map((m) => m.user_id),
  };
}

export type DashboardListData = Awaited<ReturnType<typeof fetchDashboardListData>>;

export async function fetchInvoiceDetailForOrg(supabase: ReturnType<typeof createClient>, orgId: string, invoiceId: string) {
  const { data: selected } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!selected) return null;

  // Tier 1: every read here depends only on `selected` above (its id,
  // vendor_name, or supplier_id) — none depend on each other's result —
  // so all nine go out together instead of the three-to-five separate
  // round trips this used to be (the supplier-defaults/QBO-vendor lookup
  // in particular used to wait for this whole batch to finish first, even
  // though it never actually needed any of this batch's data).
  const [signed, approvalsRes, commentsRes, docsRes, lineItemsRes, auditRes, instrRes, supplierDefaultsRes, matchedSupplierRes] =
    await Promise.all([
      supabase.storage.from("invoices").createSignedUrl(selected.file_path, 60 * 10),
      supabase.from("invoice_approvals").select("*").eq("invoice_id", selected.id),
      supabase
        .from("invoice_comments")
        .select("*")
        .eq("invoice_id", selected.id)
        .order("created_at", { ascending: true }),
      supabase
        .from("invoice_documents")
        .select("*")
        .eq("invoice_id", selected.id)
        .order("created_at", { ascending: true }),
      supabase
        .from("invoice_line_items")
        .select("*")
        .eq("invoice_id", selected.id)
        .order("line_order", { ascending: true }),
      supabase
        .from("audit_log")
        .select("*")
        .eq("invoice_id", selected.id)
        .order("created_at", { ascending: true }),
      supabase
        .from("accounting_instructions")
        .select("id, author_id, body, created_at")
        .eq("invoice_id", selected.id)
        .order("created_at", { ascending: true }),
      selected.vendor_name && selected.supplier_id
        ? supabase
            .from("supplier_defaults")
            .select("*")
            .eq("organization_id", orgId)
            .eq("supplier_id", selected.supplier_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      selected.vendor_name
        ? supabase
            .from("qbo_suppliers")
            .select("qbo_vendor_id")
            .eq("organization_id", orgId)
            .eq("name_normalized", normalizeForMatching(selected.vendor_name))
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

  const signedFileUrl = signed.data?.signedUrl ?? null;
  const approvals = approvalsRes.data ?? [];
  const comments = commentsRes.data ?? [];
  const lineItems = lineItemsRes.data ?? [];
  const auditEntries = auditRes.data ?? [];

  let supplierDefaults: SupplierDefaultsValues = {
    category: "",
    class: "",
    project_id: "",
    tax_rate: "",
    payment_terms_days: "",
    currency: "",
  };
  let qboVendorId: string | null = null;

  if (selected.vendor_name) {
    const sd = supplierDefaultsRes.data;
    qboVendorId = matchedSupplierRes.data?.qbo_vendor_id ?? null;
    if (sd) {
      supplierDefaults = {
        category: sd.category ?? "",
        class: sd.class ?? "",
        project_id: sd.project_id ?? "",
        tax_rate: sd.tax_rate?.toString() ?? "",
        payment_terms_days: sd.payment_terms_days?.toString() ?? "",
        currency: sd.currency ?? "",
      };
    } else {
      const firstLine = lineItems[0];
      const termsDays =
        selected.bill_date && selected.due_date
          ? Math.round(
              (new Date(`${selected.due_date}T00:00:00Z`).getTime() -
                new Date(`${selected.bill_date}T00:00:00Z`).getTime()) /
                (1000 * 60 * 60 * 24)
            )
          : null;
      supplierDefaults = {
        category: firstLine?.category ?? "",
        class: firstLine?.class ?? "",
        project_id: firstLine?.project_id ?? "",
        tax_rate: firstLine?.tax_rate?.toString() ?? "",
        payment_terms_days: termsDays != null && termsDays >= 0 ? termsDays.toString() : "",
        currency: selected.currency ?? "",
      };
    }
  }

  const attachmentRows = docsRes.data ?? [];
  const attachmentUrls = await Promise.all(
    attachmentRows.map(async (d) => {
      const { data } = await supabase.storage.from("invoices").createSignedUrl(d.file_path, 60 * 10);
      return data?.signedUrl ?? null;
    })
  );
  const documents: DocumentRef[] = [
    ...(signedFileUrl
      ? [
          {
            name: selected.file_name,
            url: signedFileUrl,
            isPdf: isPdfName(selected.file_name),
            isImage: isImageName(selected.file_name),
          },
        ]
      : []),
    ...attachmentRows.map((d, i) => ({
      name: d.file_name,
      url: attachmentUrls[i] ?? null,
      isPdf: isPdfName(d.file_name),
      isImage: isImageName(d.file_name),
    })),
  ];

  const instrRows = instrRes.data ?? [];
  const authorIds = [
    ...new Set(
      [
        ...comments.map((c) => c.author_id),
        ...auditEntries.map((a) => a.actor_id),
        ...instrRows.map((r) => r.author_id),
      ].filter((id): id is string => !!id)
    ),
  ];
  const { data: authors } =
    authorIds.length > 0
      ? await supabase.from("profiles").select("id, full_name").in("id", authorIds)
      : { data: [] };
  const authorNameById: Record<string, string> = {};
  for (const a of authors ?? []) authorNameById[a.id] = a.full_name ?? "Team member";

  return {
    invoice: selected,
    approvals,
    comments,
    lineItems,
    auditEntries,
    documents,
    supplierDefaults,
    qboVendorId,
    authorNameById,
    instructionEntries: instrRows.map((r) => ({
      id: r.id,
      authorName: r.author_id ? authorNameById[r.author_id] ?? "Team member" : "System",
      body: r.body,
      createdAt: r.created_at,
    })),
  };
}

export async function fetchInvoiceDetail(invoiceId: string) {
  const { supabase, org } = await requireOrg();
  return fetchInvoiceDetailForOrg(supabase, org.id, invoiceId);
}

export type InvoiceDetailData = Awaited<ReturnType<typeof fetchInvoiceDetail>>;

// Marks read ONLY the specific notification a navigation came from (see
// the original page's identical rule) — called once, client-side, right
// after the initial id+n is read from the URL on mount.
export async function markNotificationReadForDashboard(notificationId: string) {
  const { supabase, user } = await requireOrg();
  await supabase
    .from("notifications")
    .update({ read: true })
    .eq("id", notificationId)
    .eq("user_id", user.id);
}
