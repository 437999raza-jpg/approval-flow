# Production Acceptance Checklist

Run through this before (and just after) going live with each customer org.
Every item is a concrete check: what to do and what you should see. Tick each
box. Anything that doesn't match is a bug to fix before production.

Last updated: 2026-08-25 (matches the session log in README.md).

---

## 0. Before you start

- [ ] Migrations 0049–0058 are all applied to the LIVE database (run each in
      the Supabase SQL editor; none should error).
- [ ] The app deploys from GitHub `main` (Vercel) and shows **Ready**.
- [ ] You can log in at `flow.ufirst.co` as the org admin.
- [ ] `.env.local` / Vercel have the values from the README "Config state"
      (INBOUND_EMAIL_DOMAIN, INBOUND_EMAIL_WEBHOOK_SECRET matching the Resend
      webhook URL, RESEND_API_KEY, CRON_SECRET, production QBO keys).

---

## 1. Multi-tenant & security posture

- [ ] Two orgs never see each other's data: sign in as a member of org A and
      confirm org B's invoices/queue/settings are invisible.
- [ ] RLS is enabled on every table (all 20+ tables incl. `ingest_jobs`,
      `upload_log`, `qbo_sync_log`). Verify a few in the Supabase dashboard.
- [ ] No hardcoded org IDs in the app code (`grep` for a known org UUID in
      `src/` returns nothing).
- [ ] The service-role key exists only in server env (never in the browser
      bundle).
- [ ] File storage is org-scoped: invoice files live under `{org_id}/…` and
      storage policies check the org folder.
- [ ] Org switcher is NOT built (known limitation): a user belongs to one org
      at a time in this MVP. Confirm this is acceptable for launch.

---

## 2. Invoice ingestion — manual upload

- [ ] Add invoice → drop a PDF → **returns instantly** (no 20–60s freeze);
      shows **Processing…** → flips to **Processed** with an invoice link.
- [ ] Drop 3 files at once → all appear in the live queue, processed one at a
      time.
- [ ] Drop a `.txt` → shows **Rejected** with a reason ("Not a PDF or image").
- [ ] Drop a multi-invoice PDF (e.g. 6 invoices stapled) → **Split review**;
      the pending-splits page lets you confirm/adjust page ranges.
- [ ] Refresh the page → **Recent uploads** still shows the uploads with their
      outcomes (DB-backed).
- [ ] The extraction fills: vendor, invoice number, dates, currency, total,
      line items.

## 3. Invoice ingestion — email (Resend)

- [ ] Send a PDF to `fluid@flow.ufirst.co` → the Queue shows an **Email**
      entry: **Processing…** → **Processed** with the invoice link.
- [ ] Send an email with **3 attachments** (invoice + backup + certificate) →
      **ONE** invoice; the merge keeps attachment order (invoice first).
- [ ] Open the merged invoice → **Rearrange or delete pages** works: move
      pages, delete unwanted pages, Apply → the PDF is rebuilt + re-extracts.
- [ ] Send an email with no invoice data (drawing scans, images with nothing)
      → Queue shows **"No invoice data"** (grey) — NO invoice created; delete
      it with ✕, or **Reprocess** after fixes.
- [ ] A transient extraction failure does NOT permanently reject: the Queue
      shows **Failed** with a retryable message; **Reprocess** re-runs it.
- [ ] Unmatched address (send to `nobody@flow.ufirst.co`) → **Unmatched** in
      the Queue.
- [ ] The email log entry shows the sender, subject, and outcome; timestamps
      display in YOUR local time.

## 4. The Queue

- [ ] Dashboard header shows the blue **Queue** button and the sidebar a
      **Queue** link — both **admin-only** (members/auditors don't see them;
      non-admins hitting `/queue` are redirected).
- [ ] Default view is **All**; tabs (All/Pending/Processed/Failed) filter.
- [ ] Every entry shows: time (local), Upload/Email badge, title, status
      chip, and links to created invoices.
- [ ] Admin ✕ removes a single entry; **Clear completed** removes ONLY
      fully-processed items (uploads that became invoices + emails that
      produced invoices) — pending/failed/unmatched/split-review entries
      survive.
- [ ] **Reprocess** appears on failed / no-invoice entries and re-runs them
      with the current logic (no re-forwarding, no duplicate warning).

## 5. Extraction quality & hard rules

- [ ] Multi-page documents: change-order pages are read and their line items
      included; nothing duplicated across pages.
- [ ] Holdbacks: "Less 10% holdback" / "HOLD-BACK" / "10% hold back" →
      tagged **2-1031 - HB Payable** with a **negative** amount, at ingest
      AND after re-extract.
- [ ] **Class NEVER comes from the document** — line items ingest with a
      blank class, even if the supplier prints class codes (e.g. 6000).
      Class is only set by a human (or CO/Extras → "Extras").
- [ ] Default tax rate: with the org default set to 13%, new invoices without
      a supplier rule get 13% on their line items.
- [ ] Supplier rules (category/tax/currency/payment terms) beat extraction
      for the fields they cover; they never supply class or project.
- [ ] Project comes ONLY from PO detection or a human — never from the
      document or a rule; a manual project choice survives re-extract.

## 6. Totals — "the total must match at all costs"

- [ ] When line items sum ≠ printed total → the **document total wins** and an
      **amber note** explains it.
- [ ] When the printed total couldn't be read at all → the amber note says the
      amount was derived from line items and must be verified.
- [ ] **Fix the line items to sum to the document total → the amber note
      disappears** (recompute re-runs the reconciliation against
      `document_total`).
- [ ] The amount that flows to QBO is the reconciled amount.

## 7. QuickBooks Online — the two hard rules

- [ ] **Nothing reaches QBO until the full approval workflow completes AND an
      admin presses the final button.** Verify: a bill in `on_review` cannot
      sync; only `qbo_ready` (after all steps) shows the final Sync action.
- [ ] **Flow never creates suppliers.** A bill with an unmatched vendor shows
      the warning and CANNOT sync until a human picks an existing QBO
      supplier. Add a NEW supplier in QBO → Refresh data in Settings → the
      next sync matches it.
- [ ] Vendor matching is EXACT (normalized, with a single deterministic
      trailing-suffix strip). A near-miss is a mismatch — never fuzzy.
- [ ] After the final sync: the bill appears in QBO with vendor, line items
      (category/class/tax), memo (accounting instructions thread), and the
      audit-trail PDF + documents attached; the invoice status becomes
      `approved`.
- [ ] Line classes (incl. "Extras" for CO/Extras) flow to QBO; "Extras" lines
      are locked once the CO/Extras flag is decided.

## 8. Settings

- [ ] Each QBO mirror section (Tax/Classes/Projects/Suppliers/Categories)
      shows "N on File. Last synced on <your local time>" and only newly
      synced items below; all sync buttons are the same blue.
- [ ] Sync suppliers → the count updates and new suppliers appear; the change
      is visible everywhere (dashboard dropdowns) without a manual refresh.
- [ ] Default tax rate: pick a rate → Save lights up; after saving it shows
      the saved rate and the button greys to "Saved" until you pick another.
- [ ] Invoice email (Integrations): set the friendly local part (e.g.
      `fluid`) → the capture address shows `fluid@flow.ufirst.co`; the old
      token address still works.
- [ ] Sync/save buttons keep your scroll position (no jump to top).
- [ ] Change a member's role / remove a member → reflected immediately
      (roster cache invalidates).

## 9. Performance

- [ ] Clicking between invoices is fast — the invoice list, QBO mirrors, and
      member roster are cached and don't re-download on every navigation.
- [ ] Uploading/emailing never blocks the app for 20–60s (async extraction).
- [ ] After any action (approve, save, upload, email), the list reflects it
      within seconds (cache invalidated correctly).
- [ ] The Queue never grows unbounded: 90-day auto-cleanup + Clear completed.

## 10. Reporting data (for later metrics)

- [ ] `upload_log` has one row per manual upload: status
      (queued/processing/done/split/error/no_invoice), invoice/split link,
      error, created_at → processed_at (processing time).
- [ ] `inbound_email_log` has one row per email: sender, subject, outcome,
      invoice/split ids, processing flag.
- [ ] `ingest_jobs` shows the async queue state (queued/processing/done/error)
      with attempt counts.

---

## Known limitations at launch (accepted)

- [ ] No org switcher (one org per user in this MVP).
- [ ] No self-serve signup — orgs are created manually.
- [ ] Billing rate is a single env var, not per-org.
- [ ] Split confirmation and manual Re-extract still run inline (20–60s) —
      only uploads/emails are fully async.
- [ ] Jobs wait while nobody has the app open (Hobby poller) — no scheduled
      worker yet.
- [ ] Duplicate detection and supplier defaults match on normalized vendor
      text, not a linked Supplier entity.
