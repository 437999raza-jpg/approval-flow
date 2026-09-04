import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyDecisionToken } from "@/lib/decision-token";
import {
  recordDecision,
  recordRejectionWithReason,
  requiredApproversFor,
} from "@/lib/dashboard-actions";
import { computeLineItemTotals } from "@/lib/invoice-totals";
import { getAppUrl } from "@/lib/app-url";

// Approve/reject an invoice straight from the "it's your turn" email, no
// sign-in required — the single most-used feature in every competitor
// (ApprovalMax, Bill.com) this app was missing. Deliberately OUTSIDE the
// (app) route group (whose layout forces a login redirect) and reachable
// by an anonymous visitor.
//
// The email link is a GET to THIS page only — never a GET that executes
// the decision directly. Corporate email-security scanners (Defender for
// Office 365, Proofpoint, etc.) auto-fetch every link in a delivered
// email to check it for safety; a GET-executes endpoint would let a
// scanner silently approve or reject bills nobody ever looked at. Only
// an explicit form POST (a real click, below) records anything.
//
// Uses the admin client throughout (there's no session to scope RLS to)
// and re-derives eligibility fresh via requiredApproversFor on every
// load — the same live check the dashboard's decide() runs, so a stale,
// reused, or forwarded link just shows "no longer needs your decision"
// instead of executing on outdated state. Authored by Araza.

async function loadDecisionContext(token: string) {
  const verified = verifyDecisionToken(token);
  if (!verified) return { state: "invalid" as const };

  const admin = createAdminClient();
  const { data: invoice } = await admin
    .from("invoices")
    .select("*")
    .eq("id", verified.invoiceId)
    .maybeSingle();
  if (!invoice || !invoice.workflow_id) return { state: "invalid" as const };

  if (invoice.status !== "on_approval") {
    return { state: "already-decided" as const, invoice };
  }

  const { data: steps } = await admin
    .from("approval_workflow_steps")
    .select("*")
    .eq("workflow_id", invoice.workflow_id)
    .order("step_order", { ascending: true });
  const currentStep = (steps ?? []).find((s) => s.step_order === invoice.current_step_order);
  if (!currentStep) return { state: "already-decided" as const, invoice };

  const requiredApproverIds = await requiredApproversFor(admin, currentStep, invoice);
  if (!requiredApproverIds.includes(verified.userId)) {
    return { state: "not-your-turn" as const, invoice };
  }

  const { data: lineItems } = await admin
    .from("invoice_line_items")
    .select("amount, tax_rate")
    .eq("invoice_id", invoice.id);
  const { total } = computeLineItemTotals(lineItems ?? []);

  const invoiceLabel = `${invoice.vendor_name ?? invoice.file_name}${
    invoice.invoice_number ? ` #${invoice.invoice_number}` : ""
  }`;

  return {
    state: "ready" as const,
    invoice,
    userId: verified.userId,
    stepName: currentStep.name || null,
    invoiceLabel,
    amountLabel: total.toLocaleString(undefined, { style: "currency", currency: invoice.currency || "CAD" }),
  };
}

async function approveDecisionAction(formData: FormData) {
  "use server";
  const token = String(formData.get("token") ?? "");
  const verified = verifyDecisionToken(token);
  if (!verified) redirect(`/decide?token=${encodeURIComponent(token)}`);

  const instructions = String(formData.get("instructions") ?? "").trim();
  const admin = createAdminClient();
  const result = await recordDecision(admin, verified.userId, verified.invoiceId, "approved", instructions);
  redirect(
    `/decide?token=${encodeURIComponent(token)}&result=${result.ok ? "approved" : result.error}`
  );
}

async function rejectDecisionAction(formData: FormData) {
  "use server";
  const token = String(formData.get("token") ?? "");
  const verified = verifyDecisionToken(token);
  if (!verified) redirect(`/decide?token=${encodeURIComponent(token)}`);

  const reason = String(formData.get("reason") ?? "");
  const admin = createAdminClient();
  const result = await recordRejectionWithReason(admin, verified.userId, verified.invoiceId, reason);
  redirect(
    `/decide?token=${encodeURIComponent(token)}&result=${result.ok ? "rejected" : result.error}`
  );
}

const ERROR_COPY: Record<string, string> = {
  "not-your-step": "This bill has already moved on — someone else must have already decided this step.",
  "trial-locked": "This organization's trial has ended, so decisions are paused until a plan is chosen.",
  "already-decided": "This bill has already been decided.",
  "reject-reason-required": "A reason is required to reject — please try again.",
};

export default async function DecidePage({
  searchParams,
}: {
  searchParams: { token?: string; result?: string };
}) {
  const token = searchParams.token ?? "";
  if (!token) {
    return <Shell title="Missing link">This link is incomplete. Please open the button from the original email again.</Shell>;
  }

  // A result param means a decision was just POSTed — show the outcome
  // rather than re-running the eligibility check (which would now
  // correctly say "already decided" for a successful approve/reject,
  // masking which one just happened).
  if (searchParams.result === "approved" || searchParams.result === "rejected") {
    return (
      <Shell title={searchParams.result === "approved" ? "Approved" : "Rejected"}>
        You {searchParams.result} this bill. You can sign in to Flow if you&apos;d like to see the full invoice or leave a comment.
        <div className="mt-5">
          <a href={`${getAppUrl()}/login`} style={linkButtonStyle}>
            Sign in to Flow
          </a>
        </div>
      </Shell>
    );
  }
  if (searchParams.result && ERROR_COPY[searchParams.result]) {
    return <Shell title="Couldn't record that">{ERROR_COPY[searchParams.result]}</Shell>;
  }

  const context = await loadDecisionContext(token);

  if (context.state === "invalid") {
    return (
      <Shell title="This link is no longer valid">
        It may have expired, or the bill it points to no longer exists. Sign in to Flow to find it directly.
        <div className="mt-5">
          <a href={`${getAppUrl()}/login`} style={linkButtonStyle}>
            Sign in to Flow
          </a>
        </div>
      </Shell>
    );
  }

  if (context.state === "already-decided") {
    return <Shell title="Already decided">This bill has already moved past this step.</Shell>;
  }

  if (context.state === "not-your-turn") {
    return <Shell title="No longer needs your decision">Someone else must have already acted on this, or it was reassigned.</Shell>;
  }

  return (
    <Shell title="Waiting on you">
      <p style={{ margin: "0 0 4px 0", fontWeight: 600, color: "#0f172a" }}>{context.invoiceLabel}</p>
      <p style={{ margin: "0 0 20px 0", color: "#475569" }}>
        {context.amountLabel}
        {context.stepName ? ` · ${context.stepName}` : ""}
      </p>

      <form action={approveDecisionAction} style={{ marginBottom: 16 }}>
        <input type="hidden" name="token" value={token} />
        <label style={labelStyle}>
          Instructions for accounting (optional)
          <textarea name="instructions" rows={2} style={textareaStyle} />
        </label>
        <button type="submit" style={{ ...buttonStyle, background: "#059669" }}>
          Approve
        </button>
      </form>

      <form action={rejectDecisionAction}>
        <input type="hidden" name="token" value={token} />
        <label style={labelStyle}>
          Reason for rejecting (required)
          <textarea name="reason" rows={2} required style={textareaStyle} />
        </label>
        <button type="submit" style={{ ...buttonStyle, background: "#ffffff", color: "#334155", border: "1px solid #cbd5e1" }}>
          Reject
        </button>
      </form>
    </Shell>
  );
}

const linkButtonStyle: React.CSSProperties = {
  display: "inline-block",
  background: "#0f172a",
  color: "#ffffff",
  textDecoration: "none",
  fontSize: 14,
  fontWeight: 600,
  padding: "10px 20px",
  borderRadius: 6,
};
const labelStyle: React.CSSProperties = { display: "block", fontSize: 13, color: "#475569", marginBottom: 10 };
const textareaStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 6,
  padding: "8px 10px",
  fontSize: 14,
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontFamily: "inherit",
};
const buttonStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  padding: "10px 20px",
  borderRadius: 6,
  cursor: "pointer",
};

// Plain inline styles, not Tailwind classes — this route sits outside
// the app shell entirely (no globals.css guaranteed to be loaded the
// same way for an anonymous, unauthenticated visitor arriving straight
// from an email client's link preview), so it can't depend on the rest
// of the app's build pipeline.
function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#f1f5f9", minHeight: "100vh", padding: "48px 16px", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" }}>
      <div style={{ maxWidth: 440, margin: "0 auto", background: "#ffffff", borderRadius: 10, boxShadow: "0 1px 3px rgba(15,23,42,0.08)", padding: 28 }}>
        <h1 style={{ margin: "0 0 16px 0", fontSize: 18, color: "#0f172a" }}>{title}</h1>
        <div style={{ fontSize: 14, lineHeight: 1.6, color: "#334155" }}>{children}</div>
      </div>
    </div>
  );
}
