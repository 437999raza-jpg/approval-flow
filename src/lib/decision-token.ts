import crypto from "crypto";
import { getAppUrl } from "@/lib/app-url";

// Lets an "it's your turn" email carry working Approve/Reject buttons
// without requiring sign-in first — the single biggest daily-use feature
// in every competitor (ApprovalMax, Bill.com) we're missing today.
//
// Stateless HMAC token (invoiceId + userId + expiry), not a DB-backed
// one-time-use row: no table, no cleanup cron. "Single use" falls out
// for free — once a decision is recorded the invoice moves off this
// step, so a reused/forwarded link just fails the same live eligibility
// check (requiredApproversFor) an already-decided dashboard click would
// also fail. Same HMAC-SHA256 + timing-safe-compare pattern already used
// for the Stripe webhook signature (src/app/api/webhooks/stripe/route.ts).
//
// The email link itself is a GET to a confirmation PAGE, never a GET
// that executes the decision directly — corporate email-security
// scanners (Defender for Office 365, Proofpoint, etc.) auto-fetch every
// link in a delivered email to check it for safety, and a GET-executes
// endpoint would let a scanner silently approve or reject bills nobody
// ever looked at. The page requires an explicit form POST (a real click)
// before anything is recorded.
//
// Authored by Araza.

const DEFAULT_TTL_DAYS = 14;

function secret(): string | null {
  return process.env.EMAIL_DECISION_SECRET || null;
}

export function createDecisionToken(
  invoiceId: string,
  userId: string,
  ttlDays = DEFAULT_TTL_DAYS
): string | null {
  const key = secret();
  if (!key) return null; // feature quietly disabled if unconfigured — see notify.ts callers

  const exp = Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60;
  const payload = Buffer.from(JSON.stringify({ i: invoiceId, u: userId, e: exp })).toString(
    "base64url"
  );
  const sig = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyDecisionToken(token: string): { invoiceId: string; userId: string } | null {
  const key = secret();
  if (!key) return null;

  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;

  const expectedSig = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let data: { i?: string; u?: string; e?: number };
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (!data.i || !data.u || typeof data.e !== "number") return null;
  if (data.e < Math.floor(Date.now() / 1000)) return null;

  return { invoiceId: data.i, userId: data.u };
}

export function decisionUrl(action: "approve" | "reject", invoiceId: string, userId: string): string | null {
  const token = createDecisionToken(invoiceId, userId);
  if (!token) return null;
  return `${getAppUrl()}/decide?action=${action}&token=${encodeURIComponent(token)}`;
}
