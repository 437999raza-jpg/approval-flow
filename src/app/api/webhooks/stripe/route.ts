// Stripe webhook — the reliable backstop for "did this payment actually
// happen." Until now, the only signal that a Checkout session succeeded
// was the browser landing back on /billing?payment=success — which
// never fires if the customer closes the tab right after paying (the
// existing confirmSetupFeePayment already carries this exact caveat in
// its own comment). No Stripe SDK, matching every other Stripe call in
// this app (dashboard-actions.ts) — signature verification is ~15 lines
// of HMAC, not worth a dependency for.
//
// Migration 0119 added real autopay subscriptions alongside the
// original one-time "Pay now" Checkout, so this now listens for:
//   - checkout.session.completed — unchanged for mode "payment"
//     (usage/setup-fee); new metadata.type "enable_autopay" case for
//     mode "subscription" writes the resulting subscription id.
//   - invoice.payment_failed / invoice.payment_succeeded — only ever
//     fire for subscription invoices (a one-time Checkout never
//     produces an Invoice object), so no extra mode check is needed.
//   - customer.subscription.deleted — a cancellation made through the
//     Stripe Billing Portal; the org falls back to the existing manual
//     "Pay now" reminder flow with no special casing needed elsewhere.
//
// Setup:
//   1. Stripe Dashboard → Developers → Webhooks → Add endpoint
//      → https://flow.ufirst.co/api/webhooks/stripe
//      → select events: checkout.session.completed, invoice.payment_failed,
//        invoice.payment_succeeded, customer.subscription.deleted
//   2. Copy the signing secret it shows into STRIPE_WEBHOOK_SECRET.
//
// Authored by Araza.

import { NextResponse } from "next/server";
import crypto from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendAutopayFailedEmail } from "@/lib/notify";
import { platformAdminEmails } from "@/lib/platform-admin";
import { getAppUrl } from "@/lib/app-url";

// Stripe's own Smart Retries space failed-charge attempts out over
// roughly two weeks — re-notifying on every single retry would mean up
// to half a dozen emails for one still-unresolved card. Matches the
// renotify-window pattern already used for the manual usage reminder.
const AUTOPAY_FAILURE_RENOTIFY_DAYS = 5;

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

interface StripeEvent {
  type: string;
  data: {
    object: {
      id: string;
      // checkout.session.completed
      payment_status?: string;
      subscription?: string | null;
      metadata?: {
        organization_id?: string;
        type?: string;
        setup_fee?: string;
      };
      // invoice.payment_failed / invoice.payment_succeeded /
      // customer.subscription.deleted all carry a `customer` id — that's
      // how each is matched back to an org (organizations.stripe_customer_id),
      // not metadata, since Checkout Session metadata isn't copied onto
      // the Invoice or Subscription objects it produces.
      customer?: string | null;
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

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "bad JSON" }, { status: 400 });
  }

  const admin = createAdminClient();

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.payment_status !== "paid") {
      return NextResponse.json({ ok: true, ignored: "not paid" });
    }
    const organizationId = session.metadata?.organization_id;
    if (!organizationId) {
      return NextResponse.json({ ok: true, ignored: "no organization_id" });
    }

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

    if (session.metadata?.type === "enable_autopay" && session.subscription) {
      // Checkout Session metadata isn't copied onto the Subscription it
      // creates, so the subscription (and its line item id, needed later
      // by selectPlan to change price on an upgrade/downgrade) has to be
      // fetched back from Stripe rather than read off this event.
      const stripeSecret = process.env.STRIPE_SECRET_KEY;
      if (stripeSecret) {
        try {
          const res = await fetch(
            `https://api.stripe.com/v1/subscriptions/${session.subscription}`,
            { headers: { Authorization: `Bearer ${stripeSecret}` } }
          );
          if (res.ok) {
            const sub = (await res.json()) as { id: string; items?: { data?: { id: string }[] } };
            const itemId = sub.items?.data?.[0]?.id;
            if (itemId) {
              await admin
                .from("organizations")
                .update({
                  stripe_subscription_id: sub.id,
                  stripe_subscription_item_id: itemId,
                  autopay_enabled: true,
                })
                .eq("id", organizationId);
            } else {
              console.error("enable_autopay webhook: subscription has no line item", sub.id);
            }
          } else {
            console.error("enable_autopay webhook: subscription lookup failed", res.status);
          }
        } catch (err) {
          console.error("enable_autopay webhook error:", err);
        }
      }
    }

    return NextResponse.json({ ok: true });
  }

  if (event.type === "invoice.payment_succeeded") {
    const customerId = event.data.object.customer;
    if (!customerId) return NextResponse.json({ ok: true, ignored: "no customer" });
    // Same fields the manual "Pay now" flow stamps — a successful
    // autopay charge should suppress the manual-reminder cron exactly
    // as if the customer had clicked "Pay now" themselves, with no
    // separate suppression logic needed there.
    await admin
      .from("organizations")
      .update({
        usage_last_paid_at: new Date().toISOString(),
        usage_reminder_sent_at: null,
        subscription_payment_failed_at: null,
      })
      .eq("stripe_customer_id", customerId);
    return NextResponse.json({ ok: true });
  }

  if (event.type === "invoice.payment_failed") {
    const customerId = event.data.object.customer;
    if (!customerId) return NextResponse.json({ ok: true, ignored: "no customer" });

    const { data: org } = await admin
      .from("organizations")
      .select("id, name, subscription_payment_failed_at")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    if (!org) return NextResponse.json({ ok: true, ignored: "unknown customer" });

    const alreadyNotifiedRecently =
      org.subscription_payment_failed_at != null &&
      (Date.now() - new Date(org.subscription_payment_failed_at).getTime()) /
        (24 * 60 * 60 * 1000) <
        AUTOPAY_FAILURE_RENOTIFY_DAYS;
    if (alreadyNotifiedRecently) {
      return NextResponse.json({ ok: true, ignored: "recently notified" });
    }

    await admin
      .from("organizations")
      .update({ subscription_payment_failed_at: new Date().toISOString() })
      .eq("id", org.id);

    const { data: admins } = await admin
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", org.id)
      .eq("role", "admin");
    const orgAdminEmails = (
      await Promise.all(
        (admins ?? []).map(async (a) => (await admin.auth.admin.getUserById(a.user_id)).data.user?.email ?? null)
      )
    ).filter((e): e is string => !!e);

    const billingUrl = `${getAppUrl()}/billing`;
    const recipients = [...new Set([...orgAdminEmails, ...platformAdminEmails()])];
    await Promise.all(
      recipients.map((to) => sendAutopayFailedEmail({ to, orgName: org.name, billingUrl }))
    );

    return NextResponse.json({ ok: true });
  }

  if (event.type === "customer.subscription.deleted") {
    const customerId = event.data.object.customer;
    if (customerId) {
      // A cancellation made through the Stripe Billing Portal — fall
      // back to exactly today's manual "Pay now" reminder flow, no
      // special casing needed anywhere else in the app.
      await admin
        .from("organizations")
        .update({
          stripe_subscription_id: null,
          stripe_subscription_item_id: null,
          autopay_enabled: false,
        })
        .eq("stripe_customer_id", customerId);
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true, ignored: true });
}
