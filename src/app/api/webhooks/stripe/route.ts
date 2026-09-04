// Stripe webhook — the reliable backstop for "did this payment actually
// happen." Until now, the only signal that a Checkout session succeeded
// was the browser landing back on /billing?payment=success — which
// never fires if the customer closes the tab right after paying (the
// existing confirmSetupFeePayment already carries this exact caveat in
// its own comment). No Stripe SDK, matching every other Stripe call in
// this app (dashboard-actions.ts) — signature verification is ~15 lines
// of HMAC, not worth a dependency for.
//
// Listens for checkout.session.completed only — the one event type this
// app's Stripe integration can ever produce, since every charge here is
// a one-off Checkout session (mode: "payment"), never a subscription.
//
// Setup:
//   1. Stripe Dashboard → Developers → Webhooks → Add endpoint
//      → https://flow.ufirst.co/api/webhooks/stripe
//      → select event: checkout.session.completed
//   2. Copy the signing secret it shows into STRIPE_WEBHOOK_SECRET.
//
// Authored by Araza.

import { NextResponse } from "next/server";
import crypto from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";

// Stripe's own tolerance is 5 minutes — reject anything older to make a
// captured/replayed request (the raw body + signature, if ever leaked)
// useless past that window.
const TOLERANCE_SECONDS = 5 * 60;

function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string
): boolean {
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, v];
    })
  );
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

interface CheckoutSessionEvent {
  type: string;
  data: {
    object: {
      id: string;
      payment_status?: string;
      metadata?: {
        organization_id?: string;
        type?: string;
        setup_fee?: string;
      };
    };
  };
}

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Not configured yet — 200 so Stripe doesn't retry-storm an
    // endpoint that will never succeed until the env var is set.
    console.error("Stripe webhook received but STRIPE_WEBHOOK_SECRET is not set");
    return NextResponse.json({ ok: true, error: "not configured" });
  }

  const signatureHeader = request.headers.get("stripe-signature");
  if (!signatureHeader) {
    return NextResponse.json({ error: "missing signature" }, { status: 400 });
  }

  // Raw text, not request.json() — signature verification is over the
  // exact bytes Stripe sent; parsing first would let a body that's been
  // re-serialized differently (different key order, whitespace) pass
  // JSON.parse while failing a byte-exact signature check, or vice versa.
  const rawBody = await request.text();
  if (!verifyStripeSignature(rawBody, signatureHeader, secret)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  let event: CheckoutSessionEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "bad JSON" }, { status: 400 });
  }

  if (event.type !== "checkout.session.completed") {
    return NextResponse.json({ ok: true, ignored: true });
  }

  const session = event.data.object;
  if (session.payment_status !== "paid") {
    return NextResponse.json({ ok: true, ignored: "not paid" });
  }
  const organizationId = session.metadata?.organization_id;
  if (!organizationId) {
    return NextResponse.json({ ok: true, ignored: "no organization_id" });
  }

  const admin = createAdminClient();

  if (session.metadata?.type === "usage") {
    // Clears usage_reminder_sent_at too — a fresh payment starts a new
    // overdue window, so a reminder already sent for the OLD window
    // must not suppress one earned by falling behind again later.
    await admin
      .from("organizations")
      .update({ usage_last_paid_at: new Date().toISOString(), usage_reminder_sent_at: null })
      .eq("id", organizationId);
  }

  if (session.metadata?.setup_fee === "1") {
    // Same idempotency guard as confirmSetupFeePayment (dashboard-actions.ts)
    // — whichever of the two paths lands first wins; the other is a no-op.
    await admin
      .from("organizations")
      .update({ setup_fee_paid_at: new Date().toISOString() })
      .eq("id", organizationId)
      .is("setup_fee_paid_at", null);
  }

  return NextResponse.json({ ok: true });
}
