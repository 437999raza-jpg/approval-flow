// Outbound transactional email via Resend's HTTP API (no SDK dependency —
// a single POST, consistent with how this app calls OpenRouter). Every
// call is best-effort: a missing key/misconfiguration or a failed request
// never blocks the action that triggered it (e.g. posting a comment, or
// an invoice advancing to the next approver) — see the try/catch and the
// env-var guard in each send function.
// Authored by Araza.

import { getAppUrl } from "@/lib/app-url";
import { createAdminClient } from "@/lib/supabase/admin";
import { TEMPLATE_DEFS, getTemplateOverride, resolveTemplate } from "@/lib/email-templates";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Shared card shell — table-based layout (safe across Gmail/Outlook/Apple
// Mail, unlike flexbox/grid), one accent color, one clear action. Kept
// concise on purpose: a name, what happened, optional context, one
// button. Not a bare "X did Y" paragraph — a fixed color accent bar plus
// a real button reads as an actual product notification, not a bland
// system alert.
// Urgency is graduated, not binary. An overdue notice that looks
// identical whether something is one day late or ten trains people to
// ignore all of them — the same fatigue that got approval emails deleted
// unread in the first place. So the further past its deadline a bill
// gets, the louder the treatment, and "red" still means something when
// it finally shows up.
//
// `band` colors carry white text, so each is dark enough to stay legible
// (and to survive Outlook/Gmail dark mode, which can invert a light
// background but leaves an explicitly-colored one alone).
export type Severity = "normal" | "warning" | "overdue" | "critical";

const SEVERITY: Record<
  Severity,
  { band: string; emoji: string; label: string; priority: boolean }
> = {
  normal: { band: "#2563EB", emoji: "", label: "", priority: false },
  warning: { band: "#B45309", emoji: "⏰", label: "Due now", priority: false },
  overdue: { band: "#DC2626", emoji: "🔴", label: "Overdue", priority: true },
  critical: { band: "#991B1B", emoji: "🚨", label: "Escalation", priority: true },
};

// Days past a step's deadline → how loud to be about it.
export function severityForDaysLate(daysLate: number): Severity {
  if (daysLate <= 0) return "normal";
  if (daysLate <= 2) return "warning";
  return "overdue";
}

// Outlook renders a native red "!" in the message list for these, and
// auto-files the message under a colored category — both stronger
// signals than anything we can do inside the HTML body, and both
// unaffected by dark mode or image blocking.
function urgencyHeaders(severity: Severity): Record<string, string> | undefined {
  const s = SEVERITY[severity];
  if (!s.priority) return undefined;
  return {
    "X-Priority": "1",
    Importance: "high",
    "X-MS-Categories": s.label,
  };
}

function emailShell({
  accentColor,
  eyebrow,
  headline,
  bodyHtml,
  ctaLabel,
  ctaUrl,
  bandLabel,
}: {
  accentColor: string;
  eyebrow: string;
  headline: string;
  bodyHtml: string;
  // Omitted entirely for a recipient with no Flow account to click into
  // (e.g. a vendor being asked to change how they send invoices) — a
  // fabricated CTA linking into the app would be meaningless to them.
  ctaLabel?: string;
  ctaUrl?: string;
  // When set, the 4px hairline is replaced by a full-width colored band
  // carrying this text — the part that actually reads as urgent at a
  // glance, rather than a stripe most people never consciously see.
  bandLabel?: string;
}): string {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <tr>
    <td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.08);">
        ${
          bandLabel
            ? `<tr>
          <td style="background:${accentColor};padding:13px 28px;font-size:15px;line-height:1.35;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;color:#ffffff;">${escapeHtml(bandLabel)}</td>
        </tr>`
            : `<tr>
          <td style="height:4px;background:${accentColor};line-height:4px;font-size:0;">&nbsp;</td>
        </tr>`
        }
        <tr>
          <td style="padding:28px 28px 8px 28px;">
            <p style="margin:0;font-size:11px;line-height:1.4;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#94a3b8;">${escapeHtml(eyebrow)}</p>
            <h1 style="margin:10px 0 0 0;font-size:18px;line-height:1.5;color:#0f172a;font-weight:600;">${headline}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 28px 24px 28px;font-size:14px;line-height:1.6;color:#334155;">
            ${bodyHtml}
          </td>
        </tr>
        ${
          ctaLabel && ctaUrl
            ? `<tr>
          <td style="padding:0 28px 32px 28px;">
            <a href="${ctaUrl}" style="display:inline-block;background:${accentColor};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:6px;">${escapeHtml(ctaLabel)} &rarr;</a>
          </td>
        </tr>`
            : `<tr><td style="padding:0 28px 20px 28px;">&nbsp;</td></tr>`
        }
        <tr>
          <td style="padding:14px 28px;background:#f8fafc;border-top:1px solid #eef2f7;">
            <img src="${getAppUrl()}/brand/ufirst-wordmark.png" alt="ufirst" height="14" style="display:block;height:14px;width:auto;border:0;" />
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`.trim();
}

// Shared Resend POST — `headers` are extra RFC email headers on the
// outgoing message itself (not the HTTP request), e.g. X-MS-Categories
// below. Every caller already treats a failed send as best-effort, so
// this only ever logs to the console, never throws.
async function sendEmail({
  to,
  subject,
  html,
  headers,
}: {
  to: string;
  subject: string;
  html: string;
  headers?: Record<string, string>;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) return;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html, ...(headers ? { headers } : {}) }),
    });
  } catch {
    // best-effort — the underlying action already succeeded independent of email
  }
}

// A customer wrote in the support chat and nothing told anyone. The
// widget (SupportChatWidget.tsx) is poll-only — it has no way to reach
// someone who isn't already looking at it, and there was no other
// signal at all: "if I'm not there, there's no way for me to know."
// One email per message, to every platform admin, linking straight to
// that org's thread in the Ops app.
export async function sendSupportMessageEmail({
  to,
  orgName,
  authorName,
  body,
  threadUrl,
}: {
  to: string;
  orgName: string;
  authorName: string;
  body: string;
  threadUrl: string;
}): Promise<void> {
  const html = emailShell({
    accentColor: "#2563eb",
    eyebrow: `Support · ${orgName}`,
    headline: `<strong>${escapeHtml(authorName)}</strong> sent a message`,
    bodyHtml: `<div style="margin:4px 0 0 0;padding:12px 14px;background:#f8fafc;border-left:3px solid #cbd5e1;border-radius:4px;white-space:pre-wrap;color:#475569;">${escapeHtml(body)}</div>`,
    ctaLabel: "Reply",
    ctaUrl: threadUrl,
  });

  await sendEmail({
    to,
    subject: `${orgName}: ${authorName} sent a support message`,
    html,
    headers: urgencyHeaders("overdue"),
  });
}

export async function sendMentionEmail({
  to,
  actorName,
  invoiceLabel,
  commentBody,
  invoiceUrl,
}: {
  to: string;
  actorName: string;
  invoiceLabel: string;
  commentBody: string;
  invoiceUrl: string;
}): Promise<void> {
  const html = emailShell({
    accentColor: "#2563eb",
    eyebrow: "Mentioned in a comment",
    headline: `<strong>${escapeHtml(actorName)}</strong> mentioned you on ${escapeHtml(invoiceLabel)}`,
    bodyHtml: `<div style="margin:4px 0 0 0;padding:12px 14px;background:#f8fafc;border-left:3px solid #cbd5e1;border-radius:4px;white-space:pre-wrap;color:#475569;">${escapeHtml(commentBody)}</div>`,
    ctaLabel: "Open the invoice",
    ctaUrl: invoiceUrl,
  });

  await sendEmail({ to, subject: `${actorName} mentioned you on ${invoiceLabel}`, html });
}

// A gentle nudge toward PDF, sent to whoever an email came FROM when it
// carried something other than a PDF/PNG/JPEG — a Word or Excel invoice
// still gets read (converted to a real PDF, see office-to-pdf.tsx), but
// that's a safety net, not the goal: a re-typeset copy loses the
// original's exact layout, fonts and images, where a native PDF comes
// through untouched. "Need an email template to move subs away from
// using doc files and excel files" (reported live). Sent at most once
// per sender per week (see the inbound-email webhook's own cooldown
// check) — a nag that fires on every single email would be worse than
// the habit it's trying to fix.
export async function sendPdfOnlyRequestEmail({
  to,
  organizationId,
  attachmentNames,
}: {
  to: string;
  organizationId: string;
  attachmentNames: string[];
}): Promise<void> {
  const fileList = attachmentNames.map((n) => `“${n}”`).join(", ") || "your recent attachment";
  const admin = createAdminClient();
  const [def, override] = await Promise.all([
    Promise.resolve(TEMPLATE_DEFS.pdf_only_request),
    getTemplateOverride(admin, organizationId, "pdf_only_request"),
  ]);
  const t = resolveTemplate(def, override, { fileList });
  const html = emailShell({
    accentColor: t.accentColor,
    eyebrow: t.eyebrow,
    headline: t.headline,
    bodyHtml: t.bodyHtml,
    ctaLabel: t.ctaLabel,
    ctaUrl: t.ctaUrl,
  });

  await sendEmail({ to, subject: t.subject, html });
}

// A receipt, sent to whoever an invoice email came FROM once it's been
// read in — "confirming receipt of invoice" (reported live), and a light
// touch of the advertising the same message doubles as: the sub sees this
// customer runs their invoicing through Flow, with a link to learn what
// it is. One per email (not per invoice — a multi-attachment email gets
// one receipt, not several), gated by the caller's own idempotency check
// so this never fires twice for the same email.
export async function sendInvoiceReceiptEmail({
  to,
  organizationId,
  orgName,
  invoiceCount,
}: {
  to: string;
  organizationId: string;
  orgName: string;
  invoiceCount: number;
}): Promise<void> {
  const admin = createAdminClient();
  const override = await getTemplateOverride(admin, organizationId, "invoice_receipt");
  const t = resolveTemplate(TEMPLATE_DEFS.invoice_receipt, override, {
    orgName,
    invoiceCount: String(invoiceCount),
  });
  const html = emailShell({
    accentColor: t.accentColor,
    eyebrow: t.eyebrow,
    headline: t.headline,
    bodyHtml: t.bodyHtml + `<p style="margin:12px 0 0 0;color:#94a3b8;font-size:12px;">Built with &hearts; by ufirst</p>`,
    ctaLabel: t.ctaLabel,
    ctaUrl: t.ctaUrl,
  });

  await sendEmail({ to, subject: t.subject, html });
}

// "It's your turn" — sent whenever responsibility for an invoice moves to
// a new approver: it first enters the approval workflow, advances past a
// completed step, or an admin reassigns/sets a specific stage. `reason`
// is a short, specific clause (e.g. "is ready for your approval" /
// "was reassigned to you") so the one-line headline stays concrete
// instead of a generic "an invoice needs you."
export async function sendAssignedEmail({
  to,
  invoiceLabel,
  reason,
  stepName,
  invoiceUrl,
}: {
  to: string;
  invoiceLabel: string;
  reason: string;
  stepName?: string | null;
  invoiceUrl: string;
}): Promise<void> {
  const html = emailShell({
    accentColor: "#059669",
    eyebrow: "Waiting on you",
    headline: `${escapeHtml(invoiceLabel)} ${escapeHtml(reason)}`,
    bodyHtml: stepName
      ? `<p style="margin:0;">Step: <strong>${escapeHtml(stepName)}</strong></p>`
      : `<p style="margin:0;color:#64748b;">No further approvers are ahead of you on this step.</p>`,
    ctaLabel: "Review the invoice",
    ctaUrl: invoiceUrl,
  });

  await sendEmail({ to, subject: `${invoiceLabel} ${reason}`, html });
}

// Sent to the submitter (and any earlier approver, if they're not the
// one rejecting) when an invoice is rejected — previously there was no
// email at all for this, only the Discussion comment. Sets X-MS-Categories
// on the outgoing message so Outlook auto-tags it with a "Rejected"
// category, matching the exact behavior seen in ApprovalMax's own
// rejection emails (a real header their notifications set, not just
// something in their subject line — Outlook reads it and applies the
// color-coded category itself). Other mail clients simply ignore the
// header.
export async function sendRejectedEmail({
  to,
  invoiceLabel,
  actorName,
  reason,
  invoiceUrl,
}: {
  to: string;
  invoiceLabel: string;
  actorName: string;
  reason: string;
  invoiceUrl: string;
}): Promise<void> {
  const html = emailShell({
    accentColor: "#dc2626",
    eyebrow: "Rejected",
    headline: `<strong>${escapeHtml(actorName)}</strong> rejected ${escapeHtml(invoiceLabel)}`,
    bodyHtml: `<div style="margin:4px 0 0 0;padding:12px 14px;background:#fef2f2;border-left:3px solid #fca5a5;border-radius:4px;white-space:pre-wrap;color:#7f1d1d;">${escapeHtml(reason)}</div>`,
    ctaLabel: "Open the invoice",
    ctaUrl: invoiceUrl,
  });

  await sendEmail({
    to,
    subject: `Rejected: ${invoiceLabel}`,
    html,
    headers: { "X-MS-Categories": "Rejected" },
  });
}

// Daily "where do things stand" email — one per approver who currently
// has at least one bill waiting on them, listing each with how long it's
// been sitting and a direct link. Doubles as the reminder mechanism: an
// item past its step's deadline is visually flagged, so a person who
// lets bills sit sees it called out every single day rather than a
// one-time notice they can miss. Sent by the daily cron
// (src/app/api/cron/reminders/route.ts), not by any user action.
export async function sendDigestEmail({
  to,
  items,
  dashboardUrl,
}: {
  to: string;
  items: { label: string; daysOnStep: number; overdue: boolean; url: string }[];
  dashboardUrl: string;
}): Promise<void> {
  const overdueCount = items.filter((i) => i.overdue).length;
  // Overdue first, then longest-waiting — a six-day-late bill sitting
  // below three fresh ones is how a digest gets skimmed and closed.
  const sorted = [...items].sort(
    (a, b) => Number(b.overdue) - Number(a.overdue) || b.daysOnStep - a.daysOnStep
  );
  const worstDaysLate = sorted[0]?.overdue ? sorted[0].daysOnStep : 0;
  const severity: Severity = overdueCount === 0 ? "normal" : severityForDaysLate(worstDaysLate);
  const tone = SEVERITY[severity];
  const rows = sorted
    .slice(0, 25)
    .map(
      (i) => `
      <tr>
        <td style="padding:11px 0;border-top:1px solid #eef2f7;font-size:13px;line-height:1.55;color:#334155;">
          <a href="${i.url}" style="color:#0f172a;text-decoration:none;font-weight:600;">${escapeHtml(i.label)}</a>
          ${
            i.overdue
              ? `<span style="margin-left:6px;display:inline-block;padding:1px 6px;border-radius:9999px;background:#fef2f2;color:#b91c1c;font-size:11px;font-weight:700;">OVERDUE · ${i.daysOnStep}d</span>`
              : `<span style="margin-left:6px;color:#94a3b8;font-size:11px;">${i.daysOnStep}d</span>`
          }
        </td>
      </tr>`
    )
    .join("");
  const more = items.length > 25 ? `<p style="margin:10px 0 0 0;color:#94a3b8;">+ ${items.length - 25} more</p>` : "";

  const html = emailShell({
    accentColor: tone.band,
    bandLabel:
      overdueCount > 0
        ? `${tone.emoji} ${overdueCount} overdue${worstDaysLate > 0 ? ` · up to ${worstDaysLate}d late` : ""}`
        : undefined,
    eyebrow: "Daily approvals digest",
    headline: `You have ${items.length} bill${items.length === 1 ? "" : "s"} waiting for your approval${
      overdueCount > 0 ? ` — ${overdueCount} overdue` : ""
    }`,
    bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>${more}`,
    ctaLabel: "Open your queue",
    ctaUrl: dashboardUrl,
  });

  await sendEmail({
    to,
    // The emoji leads because the inbox list is where triage actually
    // happens — the body only gets read if the subject earns the click.
    subject:
      overdueCount > 0
        ? `${tone.emoji} ${overdueCount} overdue bill${overdueCount === 1 ? "" : "s"} in your queue (${items.length} total)`
        : `${items.length} bill${items.length === 1 ? "" : "s"} waiting for your approval`,
    html,
    headers: urgencyHeaders(severity),
  });
}

// Sent to org admins when a bill blows well past its step's deadline —
// the escalation half of the timing feature (a plain daily digest isn't
// enough on its own if the approver just ignores it). Fired once per
// step (invoices.escalated_at), not daily, so admins get a single alert
// per stuck bill instead of a repeat every day it stays stuck.
export async function sendEscalationEmail({
  to,
  invoiceLabel,
  stepName,
  daysOnStep,
  deadlineDays,
  stuckOnNames,
  invoiceUrl,
}: {
  to: string;
  invoiceLabel: string;
  stepName: string | null;
  daysOnStep: number;
  deadlineDays: number;
  stuckOnNames: string[];
  invoiceUrl: string;
}): Promise<void> {
  const tone = SEVERITY.critical;
  const daysLate = daysOnStep - deadlineDays;
  const html = emailShell({
    accentColor: tone.band,
    bandLabel: `${tone.emoji} ${daysLate} day${daysLate === 1 ? "" : "s"} past deadline`,
    eyebrow: "Escalation — overdue approval",
    headline: `${escapeHtml(invoiceLabel)} has been sitting ${daysOnStep} days${
      stepName ? ` on ${escapeHtml(stepName)}` : ""
    }`,
    bodyHtml: `<p style="margin:0;">Deadline for this step is <strong>${deadlineDays} day${
      deadlineDays === 1 ? "" : "s"
    }</strong>. Waiting on: <strong>${escapeHtml(stuckOnNames.join(", ") || "unassigned")}</strong>.</p>`,
    ctaLabel: "Open the invoice",
    ctaUrl: invoiceUrl,
  });

  await sendEmail({
    to,
    subject: `${tone.emoji} Escalation: ${invoiceLabel} is ${daysLate}d past deadline`,
    html,
    headers: urgencyHeaders("critical"),
  });
}

// Ask a subcontractor to invoice for the holdback we've been withholding
// on a job that's now closing.
//
// Unlike every other send in this file, this one REPORTS whether it went.
// The others are best-effort notifications alongside an action that
// already succeeded; this one IS the action, it goes to someone outside
// the organization, and the ledger records that it was sent — so the
// caller has to know rather than assume.
//
// Subject and body are the customer's own text (see claim-template.ts),
// already substituted by the caller. Only the bill table is built here,
// because it's a table and nobody wants to hand-write one: it replaces
// {bills} where that appears, and is appended when it doesn't. The
// breakdown matters — a sub asked for "$4,617.42" with no detail has to
// dig through a year of their own billing to check it, and the ones who
// can't be bothered simply don't reply.
export async function sendHoldbackClaimEmail({
  to,
  subject,
  body,
  organizationName,
  totalAmount,
  currency,
  lines,
  replyTo,
  ctaUrl,
}: {
  to: string;
  subject: string;
  body: string;
  organizationName: string;
  totalAmount: number;
  currency: string;
  lines: { invoiceNumber: string | null; date: string | null; amount: number }[];
  replyTo?: string | null;
  ctaUrl?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) return { ok: false, error: "Email is not configured." };

  const money = (n: number) =>
    n.toLocaleString(undefined, { style: "currency", currency: currency || "CAD" });

  const rows = lines
    .map(
      (l) => `
        <tr>
          <td style="padding:6px 0;font-size:13px;color:#334155;">${escapeHtml(l.invoiceNumber ?? "—")}</td>
          <td style="padding:6px 0;font-size:13px;color:#64748b;">${escapeHtml(l.date ?? "")}</td>
          <td style="padding:6px 0;font-size:13px;color:#0f172a;text-align:right;">${money(l.amount)}</td>
        </tr>`
    )
    .join("");

  const billsTable = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;border-top:1px solid #e2e8f0;">
      <tr>
        <td style="padding:8px 0 4px 0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Invoice</td>
        <td style="padding:8px 0 4px 0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Date</td>
        <td style="padding:8px 0 4px 0;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;text-align:right;">Amount</td>
      </tr>
      ${rows}
      <tr>
        <td colspan="2" style="padding:10px 0 0 0;border-top:1px solid #e2e8f0;font-size:14px;font-weight:600;color:#0f172a;">Total to invoice</td>
        <td style="padding:10px 0 0 0;border-top:1px solid #e2e8f0;font-size:15px;font-weight:700;color:#0f172a;text-align:right;">${money(totalAmount)}</td>
      </tr>
    </table>`;

  // The body is the customer's plain text: escape it, turn blank lines
  // into paragraphs, then drop the table in.
  const paragraphs = escapeHtml(body)
    .split(/\n{2,}/)
    .map(
      (para) =>
        `<p style="margin:0 0 14px 0;font-size:14px;line-height:1.6;color:#334155;">${para.replace(
          /\n/g,
          "<br />"
        )}</p>`
    )
    .join("");
  const BILLS_TOKEN = "{bills}";
  const bodyHtml = paragraphs.includes(BILLS_TOKEN)
    ? paragraphs.replace(BILLS_TOKEN, billsTable)
    : paragraphs + billsTable;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject,
        html: emailShell({
          accentColor: "#57A14C",
          eyebrow: organizationName,
          headline: subject,
          bodyHtml,
          ctaLabel: "Send your invoice",
          ctaUrl: ctaUrl ?? `mailto:${replyTo ?? from}`,
        }),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Email provider returned ${res.status}: ${text.slice(0, 160)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Send failed." };
  }
}

// "Do we have something like this for clients" — reported live, next to
// a screenshot of ApprovalMax's own "Your Organisation has been
// disconnected from QuickBooks Online" email. flow's QBO refresh token
// can go dead the same way theirs can (revoked from Intuit's side, or
// simply expired from inactivity) — until this, that failure was
// completely silent: every QBO-dependent feature (sync, category/
// supplier refresh) just quietly stopped working with nobody told. Sent
// at most once per disconnect (see qbo.ts's getQboConnection, which
// only calls this the first time it detects the break) to every admin
// of the org.
export async function sendQboDisconnectedEmail({
  to,
  orgName,
  settingsUrl,
}: {
  to: string;
  orgName: string;
  settingsUrl: string;
}): Promise<void> {
  const html = emailShell({
    accentColor: "#DC2626",
    bandLabel: "Action needed",
    eyebrow: orgName,
    headline: "QuickBooks Online has disconnected",
    bodyHtml: `
      <p style="margin:0 0 12px 0;">flow's connection to QuickBooks Online for <strong>${escapeHtml(orgName)}</strong> has stopped working — usually because access was revoked or the connection expired from the QuickBooks side.</p>
      <p style="margin:0;">Until it's reconnected, approved bills won't sync, and QuickBooks-synced data (suppliers, classes, categories, tax rates) won't refresh.</p>
    `,
    ctaLabel: "Reconnect QuickBooks",
    ctaUrl: settingsUrl,
  });

  await sendEmail({
    to,
    subject: `${orgName}: QuickBooks Online has disconnected`,
    html,
    headers: urgencyHeaders("critical"),
  });
}

// "We have to build it" — a customer's usage payment is a manual "Pay
// now" click, not an auto-charged subscription, so nothing forces them
// back to Billing once the trial ends. Sent to the org's own admins
// when they've gone ~35 days since their last completed payment — a
// nudge, not a lockout (isOrgLocked() is untouched by this; the
// decision was explicitly "remind, don't lock" for now).
export async function sendUsagePaymentReminderEmail({
  to,
  orgName,
  billingUrl,
}: {
  to: string;
  orgName: string;
  billingUrl: string;
}): Promise<void> {
  const html = emailShell({
    accentColor: "#B45309",
    eyebrow: orgName,
    headline: "A quick billing reminder",
    bodyHtml: `
      <p style="margin:0 0 12px 0;">It's been a little while since <strong>${escapeHtml(orgName)}</strong> paid for flow usage — "Pay now" on the Billing page settles it in under a minute.</p>
      <p style="margin:0;">Nothing is blocked in the meantime — this is just a nudge so it doesn't slip.</p>
    `,
    ctaLabel: "Go to Billing",
    ctaUrl: billingUrl,
  });

  await sendEmail({ to, subject: `${orgName}: a quick billing reminder`, html });
}

// The other half of the same nudge — sent to every platform admin so a
// customer quietly falling behind on payment is something you actually
// find out about, rather than something only Stripe's own dashboard
// would show if you happened to go check it.
export async function sendUsagePaymentOverdueAdminAlert({
  to,
  orgName,
  daysSincePaid,
  orgSettingsUrl,
}: {
  to: string;
  orgName: string;
  daysSincePaid: number;
  orgSettingsUrl: string;
}): Promise<void> {
  const html = emailShell({
    accentColor: "#B45309",
    eyebrow: "Billing",
    headline: `${orgName} hasn't paid in ${daysSincePaid} days`,
    bodyHtml: `
      <p style="margin:0;">They've also been emailed a reminder. No access has been restricted — this is informational, so you know before it comes up.</p>
    `,
    ctaLabel: "View organization",
    ctaUrl: orgSettingsUrl,
  });

  await sendEmail({ to, subject: `${orgName} hasn't paid in ${daysSincePaid} days`, html });
}
