// The holdback claim email, as an editable template.
//
// Every word of it belongs to the customer: their instructions, their
// tone, their address to send invoices to. Previously only an appended
// note was editable and the rest was hardcoded in English of my
// choosing, which is fine until a customer wants to say something
// different — and they always do.
//
// Placeholders are the plain-language kind rather than a syntax anyone
// has to learn. An unknown one is left untouched rather than blanked,
// so a typo shows up as {vendr} in the preview instead of silently
// deleting itself.
//
// The bill breakdown is NOT a placeholder's worth of text — it's a
// table, and nobody wants to hand-write one — so it's inserted at
// {bills} if present, and after the body if not.
// Authored by Araza.

export const CLAIM_PLACEHOLDERS = [
  { token: "{vendor}", describes: "the subcontractor's name" },
  { token: "{project}", describes: "the job name" },
  { token: "{amount}", describes: "the total being claimed" },
  { token: "{company}", describes: "your organization's name" },
  { token: "{term}", describes: "holdback / retainage / retention" },
  { token: "{email}", describes: "where they should send the invoice" },
  { token: "{bills}", describes: "the table of bills — inserted for you" },
] as const;

export const DEFAULT_CLAIM_SUBJECT =
  "{term} release — please invoice {company} ({project})";

export const DEFAULT_CLAIM_BODY = `Hello {vendor},

{project} is closing, and we are holding {term} from your previous invoices. Please send us an invoice for the amount below so we can release it.

{bills}

Please add applicable taxes to your invoice — tax on {term} is payable when it is released, not when it was originally withheld. Email the invoice to {email} and it will reach our accounts payable directly.`;

export interface ClaimVars {
  vendor: string;
  project: string;
  amount: string;
  company: string;
  term: string;
  email: string;
}

// Substitute known tokens, leave the rest alone. Case-insensitive on the
// token name because someone will type {Vendor}.
export function fillClaimTemplate(template: string, vars: ClaimVars): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const key = name.toLowerCase() as keyof ClaimVars;
    return key in vars ? vars[key] : whole;
  });
}
