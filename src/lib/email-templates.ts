// Structured per-org overrides for a handful of outbound emails — "if a
// customer wants to pay extra for their own wording." Platform-admin
// only: the table backing this (email_template_overrides) has RLS
// enabled with NO policies, so every read/write here goes through the
// admin client from a platform-admin-gated caller (see
// saveEmailTemplateOverride in admin-actions.ts, and the "Email
// templates" section in Settings).
//
// Deliberately structured fields, not raw HTML: the shell/layout
// (emailShell in notify.ts) stays fixed — only copy and a couple of
// style knobs are editable — so a customization can never break an
// email's markup. Authored by Araza.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

export interface TemplateToken {
  key: string;
  label: string;
  example: string;
}

export interface TemplateDefaults {
  subject: string;
  eyebrow: string;
  headline: string;
  // Paragraphs separated by a blank line. May contain {{tokens}} — see
  // `tokens` below for what's available in each template.
  body: string;
  accentColor: string;
  ctaLabel?: string;
  ctaUrl?: string;
}

export interface TemplateDef {
  key: string;
  label: string;
  description: string;
  tokens: TemplateToken[];
  defaults: TemplateDefaults;
}

export type TemplateKey = "invoice_receipt" | "pdf_only_request";

// A plain Record<TemplateKey, TemplateDef> (not `as const`) so every
// entry shares the exact same TemplateDefaults shape — including the
// OPTIONAL ctaLabel/ctaUrl `pdf_only_request` leaves unset — rather than
// each being narrowed to its own literal type with the omitted fields
// missing entirely, which made `.ctaLabel`/`.ctaUrl` a type error at any
// call site that indexes by a generic TemplateKey.
export const TEMPLATE_DEFS: Record<TemplateKey, TemplateDef> = {
  invoice_receipt: {
    key: "invoice_receipt",
    label: "Invoice receipt",
    description: "Sent to whoever emailed an invoice in, once it's been read in.",
    tokens: [
      { key: "orgName", label: "Your organization's name", example: "Fluid Construction" },
      { key: "invoiceCount", label: "How many invoices the email produced", example: "1" },
    ],
    defaults: {
      subject: "Your invoice was received",
      eyebrow: "{{orgName}}",
      headline: "Your invoice was received",
      body: "Thanks — we received {{invoiceCount}} invoice(s) from you, now on its way through {{orgName}}'s approval process.",
      accentColor: "#16a34a",
      ctaLabel: "See what Flow can do",
      ctaUrl: "https://flow.ufirst.co",
    },
  },
  pdf_only_request: {
    key: "pdf_only_request",
    label: "PDF-only request",
    description: "Sent to a sender whose attachment wasn't a PDF, PNG or JPEG.",
    tokens: [
      { key: "fileList", label: "The attachment name(s) received", example: "“invoice.docx”" },
    ],
    defaults: {
      subject: "Could future invoices come as a PDF?",
      eyebrow: "A quick favor",
      headline: "Could future invoices come as a PDF?",
      body: "We received {{fileList}} and it's already been read in — nothing for you to redo.\n\nGoing forward, sending invoices as a PDF (a photo or scan works too — PNG/JPEG) instead of a Word or Excel file helps us process them faster and keeps the original formatting exactly as you sent it.\n\nThanks for bearing with us!",
      accentColor: "#2563eb",
    },
  },
};

export const TEMPLATE_KEYS = Object.keys(TEMPLATE_DEFS) as TemplateKey[];

type Supabase = SupabaseClient<Database>;
type OverrideRow = Database["public"]["Tables"]["email_template_overrides"]["Row"];

export async function getTemplateOverride(
  adminSupabase: Supabase,
  organizationId: string,
  templateKey: TemplateKey
): Promise<OverrideRow | null> {
  const { data } = await adminSupabase
    .from("email_template_overrides")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("template_key", templateKey)
    .maybeSingle();
  return data;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function substitute(text: string, tokens: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => tokens[key] ?? "");
}

// Paragraphs (blank-line separated) → the same simple <p> shape every
// hand-written bodyHtml in notify.ts already uses.
function bodyToHtml(body: string): string {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 12px 0;">${escapeHtml(p).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

export interface ResolvedTemplate {
  subject: string;
  eyebrow: string;
  headline: string;
  bodyHtml: string;
  accentColor: string;
  ctaLabel?: string;
  ctaUrl?: string;
}

// Merges an org's override (if any) over the built-in defaults field by
// field — an override that only sets, say, accent_color leaves every
// other field on the default copy, rather than needing to be
// all-or-nothing.
export function resolveTemplate(
  def: TemplateDef,
  override: OverrideRow | null,
  tokens: Record<string, string>
): ResolvedTemplate {
  const subject = substitute(override?.subject || def.defaults.subject, tokens);
  const eyebrow = substitute(override?.eyebrow || def.defaults.eyebrow, tokens);
  const headline = substitute(override?.headline || def.defaults.headline, tokens);
  const body = substitute(override?.body || def.defaults.body, tokens);
  const accentColor = override?.accent_color || def.defaults.accentColor;
  const ctaLabel = override?.cta_label ?? def.defaults.ctaLabel;
  const ctaUrl = override?.cta_url ?? def.defaults.ctaUrl;
  return { subject, eyebrow, headline, bodyHtml: bodyToHtml(body), accentColor, ctaLabel, ctaUrl };
}
