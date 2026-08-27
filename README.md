# Approval Flow

Invoice approval workflows (ApprovalMax-style), built on Next.js, deployed on
Vercel, with Supabase for Postgres, Auth, and Storage, and an OpenRouter
model for invoice field extraction.

Status: **early-stage groundwork**, not a finished product. Auth, invoice
ingestion (manual + email, with multi-invoice split detection), a
workflow-selection routing engine, ApprovalMax-style conditional per-step
approval routing (multiple approvers per step, each eligible only when an
invoice's Class/Category/Supplier/Customer matches their own conditions),
role-scoped visibility, a review queue, per-supplier default rules,
@mention notifications, and a master-detail dashboard UI are all working
end to end. See [What's not built yet](#whats-not-built-yet) for the real
gaps.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 14 (App Router), TypeScript | Server components + Route Handlers in one deployable |
| Hosting | Vercel | Pairs naturally with Next.js |
| Database / Auth / Storage | Supabase (Postgres + `@supabase/ssr`) | One backend for data, auth, and file storage; Row Level Security for multi-tenancy |
| Styling | Tailwind CSS | Fast iteration, no component library |
| Invoice field extraction | OpenRouter (any model, default `anthropic/claude-sonnet-4.5`) | Currently how extraction quality gets **tested** across models — not a locked-in production choice. Swap `OPENROUTER_MODEL` to compare. |
| Email ingestion | Resend Receiving (webhook + Attachments API) | `email.received` webhook → pull attachments via the Resend API; capture addresses on our domain like ApprovalMax/Dext |
| Outbound email | Resend (HTTP API, no SDK) | @mention notification emails — optional, best-effort (see [Dashboard UI](#dashboard-ui)) |

---

## How it fits together

```
                    ┌─────────────────────┐
  "Add invoice" ───▶│ /api/invoices/upload│──┐
  (dropzone, UI)     └─────────────────────┘  │
                                                ▼
                                      ingestInvoiceFile()
                                    (src/lib/invoice-ingest.ts)
                                                │  ├─ classifyMultiPageInvoice() — multiple
  Forwarded email ─▶┌──────────────────────┐   │  │  invoices stapled together? → pending_invoice_splits,
  (Resend receiving) │/api/webhooks/        │──┘  │  stop here for human review. Otherwise ↓
                      │inbound-email        │      │
                      └──────────────────────┘      ▼
                                          createInvoiceFromFile()
                                          (src/lib/invoices.ts)
                                                │  ├─ upload file → Supabase Storage
                                                │  ├─ extractInvoiceFields() → OpenRouter
                                                │  ├─ apply supplier_defaults, if matched
                                                │  ├─ route → selectWorkflowForInvoice()
                                                │  ├─ insert `invoices` row (status: on_review)
                                                │  └─ insert `audit_log` row
                                                ▼
                              Supabase Postgres (RLS-scoped by org + role)
                                                │
                                                ▼
                          /dashboard/[[...id]]  (master-detail UI)
              Review Complete (admin) → re-routes → Approve/Reject/Hold/Cancel
                          → invoice_approvals + audit_log
```

Both ingestion paths — the "Add invoice" button/dropzone and the inbound
email webhook — funnel through the single `ingestInvoiceFile()` function
in [`src/lib/invoice-ingest.ts`](src/lib/invoice-ingest.ts) (which itself
calls `createInvoiceFromFile()` for the normal single-invoice case — see
[Multi-invoice split detection](#multi-invoice-split-detection) for the
other case), so they get identical validation, storage, field extraction,
supplier-default overrides, and audit logging. Every new invoice lands in
`on_review` — an admin has to run Review Complete before it's actually
routed into an approval workflow (see [Invoice
lifecycle](#invoice-lifecycle--statuses)).

---

## Data model

Full schema: [`supabase/migrations/`](supabase/migrations/) (30 migrations,
`0001` → `0030`; see [Migration history](#migration-history) for what each
one added).

| Table | Purpose |
|---|---|
| `organizations` | One row per tenant. Has a unique `inbound_email_token` — the local-part of that org's inbound invoice email address. |
| `organization_members` | Join table: user ↔ org, with a `role` — `admin` / `auditor` / `user` (see [Roles](#roles--permissions)). |
| `profiles` | Mirrors `auth.users` (display name + `avatar_url`) so app tables can join without touching the `auth` schema. |
| `projects` | Org-scoped customers/jobs/classes. `qbo_id` is reserved for QuickBooks sync. Manually entered today. |
| `approval_workflows` | Named workflow per org; one is flagged `is_default`. |
| `approval_workflow_steps` | Ordered approval chain per workflow — `step_order`, a `name`, and `approval_mode` (`all`/`any`, see [Workflow routing](#workflow-routing--rules)). No longer holds an approver directly — see the next two tables. |
| `approval_workflow_step_approvers` | The approvers on one step — zero or more, each either conditional or flagged `is_default` (the fallback when no conditional approver matches). |
| `approval_workflow_step_conditions` | Per-approver conditions (`field` — class/category/supplier/customer, `operator` — matches/not_matches, `match_values`) — what makes that approver eligible for a given invoice. See [Workflow routing](#workflow-routing--rules). |
| `approval_workflow_rules` | **Workflow-selection** routing conditions (amount/requester/supplier/customer/category/class/product) — decides which *workflow* an invoice uses, not who approves within it. See [Workflow routing](#workflow-routing--rules). |
| `supplier_defaults` | Per-supplier default rules (Category/Class/Project/Tax rate/Payment terms/Currency), matched by normalized vendor name — see [Supplier default rules](#supplier-default-rules). |
| `invoices` | The core record. `status`: one of 6 values, see [Invoice lifecycle](#invoice-lifecycle--statuses). `source`: `manual`/`email`. Holds both the mapped extracted fields and the full raw `extraction` JSON. `step_override_approver_id` is an admin's per-invoice reassignment (see [Admin overrides](#admin-overrides)). |
| `invoice_line_items` | Category-details rows (Category/Description/Tax rate/Class/**Project**/Amount/Linked) — a bill can split across multiple projects, one per line. Subtotal/tax/total are derived from these rows ([`src/lib/invoice-totals.ts`](src/lib/invoice-totals.ts)), not read off the document's printed total. |
| `invoice_documents` | Extra pages beyond the primary file (multi-document support). |
| `invoice_approvals` | One row per approve/reject decision, keyed by `invoice_id` + `step_order`, unique-constrained so double-decisions are impossible even under a race. |
| `invoice_comments` | Discussion thread per invoice. `mentioned_user_ids` records who was @mentioned in that comment (resolved server-side, not parsed from free text) — see [Dashboard UI](#dashboard-ui). |
| `notifications` | In-app "you were mentioned" inbox — one row per mention, read/unread. Shown at `/notifications`; a matching email goes out separately via Resend if configured. |
| `pending_invoice_splits` | An upload that looked like it contains more than one invoice, awaiting human review at `/invoices/pending-splits` before any invoice rows are created — see [Invoice ingestion](#invoice-ingestion). |
| `workflow_change_impacts` | One row per step edit that changed who's required to approve some in-flight (`on_approval`/`on_hold`) invoice — shown as a dismissible banner on `/workflows`. See [Workflow change impact reports](#workflow-change-impact-reports). |
| `saved_reports` | Saved report configs (metric/group-by/filters) for the [Reports](#reports) page. |
| `audit_log` | Append-only activity trail per org/invoice. |
| `inbound_email_log` | Raw record of every inbound-email webhook hit, matched or not — the debugging trail for email ingestion. |

**Row Level Security** is enabled on every table. Visibility is enforced by
SECURITY DEFINER functions: `is_org_member`/`is_org_admin`/`is_org_auditor`
(role checks), `is_eligible_approver(invoice_id, user_id)` (would this user
end up as the effective approver of some step on this invoice's workflow,
given its actual class/category/supplier/customer data — see [Workflow
routing](#workflow-routing--rules)), and `can_see_invoice(inv_id)` (the
per-invoice visibility rule, built on top of `is_eligible_approver` — see
[Projects & visibility](#projects--visibility)), used by
`invoice_approvals`/`invoice_comments`/`invoice_documents`/
`invoice_line_items`'s policies. The `invoices` table's **own** read/update
policies (migration 0021) inline that same rule against the row's own
columns instead of calling `can_see_invoice(id)` — a self-referential
subquery back into `invoices` breaks `INSERT ... RETURNING` (the row being
inserted isn't visible to a subquery within the same command yet), which
is exactly what `.insert().select().single()` generates. **If you add a
new policy on `invoices` itself, don't route it through
`can_see_invoice()`** — inline the check, or any code path that inserts
and reads the row back (which is most of them) will intermittently/always
fail with `"new row violates row-level security policy"`. The inbound-email
webhook has no logged-in user, so it uses the Supabase **service role** key
([`src/lib/supabase/admin.ts`](src/lib/supabase/admin.ts)), which bypasses
RLS entirely — treat that key as a full admin credential.

**Storage**: two private buckets.
- `invoices` — files at `{organization_id}/{uuid}-{filename}`; storage RLS
  parses the first path segment as the org id to authorize access.
- `avatars` — public bucket, files at `{user_id}/avatar.{ext}`; each user
  can only write to their own folder.

---

## Migration history

Each migration is small, has a comment block explaining itself, and is
written to be idempotent (safe to re-run). Roughly:

| # | Adds |
|---|---|
| 0001 | Core schema: orgs, members, workflows/steps, invoices, approvals, comments, audit log, inbound email log. RLS + the `invoices` storage bucket. |
| 0002 | Unique `(invoice_id, step_order)` on `invoice_approvals` (race-proof decisions); org members can read each other's profiles. |
| 0003 | `invoice_documents` — multi-document support. |
| 0004 | `accounting_instructions` on invoices (the Bill panel's memo field). |
| 0005 | `invoice_line_items` — editable Category-details rows. |
| 0006 | `projects` table; invoices link to a project; admin-only member management (`is_org_admin`). |
| 0007 | Fixes infinite recursion in the org-admin RLS policy from 0006. |
| 0008 | Workflow-managed access model: `approval_workflow_projects`, `can_see_invoice()`. |
| 0009 | `approval_workflow_rules` — the routing engine's conditions. |
| 0010 | `saved_reports`. |
| 0011 | `extraction` jsonb column — the full raw OpenRouter payload, not just the mapped fields. |
| 0012 | `pending_review` status — the review queue (later renamed `on_review`, see 0017). |
| 0013 | `held` status (later `on_hold`). |
| 0014 | Three-role model: `admin` / `auditor` / `user` (from `approver`/`submitter`); `can_see_invoice()` updated for auditor read-only-everything. |
| 0015 | Review is admin-only; `pending_review` invoices hidden from `user` role. |
| 0016 | `avatars` storage bucket + per-user upload policies. |
| 0017 | **Simplifies the status set** to 6 values matching ApprovalMax's own (On review/On approval/Approved/Cancelled/Rejected/On hold), collapsing `pending`/`in_review`/`pending_review`/`held`/`paid`. Adds real Cancel support. |
| 0018 | `step_override_approver_id` on invoices — per-invoice admin reassignment. |
| 0019 | `project_id` on `invoice_line_items` — bills can split across multiple projects; `can_see_invoice()` extended to match on any line item's project. |
| 0020 | `supplier_defaults` — per-supplier default rules, matched by normalized vendor name. |
| 0021 | Fixes `"new row violates row-level security policy for table invoices"` on every new invoice insert — see the RLS note above. |
| 0022 | Admin-only permanent invoice deletion; `audit_log.invoice_id` switched to `on delete set null` so the "invoice.deleted" entry itself survives the deletion it records. |
| 0023 | Fixes a silent gap since day one: `audit_log` had RLS enabled but no INSERT policy, so every non-service-role audit-log write failed quietly. |
| 0024 | `pending_invoice_splits` — multi-invoice upload detection holds a suspect upload for human review instead of silently keeping only the first invoice. |
| 0025 | Fixes the storage-side twin of 0023: the `invoices` bucket had no DELETE policy, so file cleanup (invoice deletion, dismissed splits) was a silent no-op. |
| 0026 | `notifications` + `mentioned_user_ids` on `invoice_comments` — @mention teammates in Discussion, with an in-app inbox and (optionally) email via Resend. |
| 0027 | **The conditional-approval redesign.** Replaces `approval_workflow_steps.approver_user_id` (one approver per step) with `approval_workflow_step_approvers` + `approval_workflow_step_conditions` — a step can now have several approvers, each eligible only when their own Class/Supplier/Customer condition matches, plus an optional default approver fallback. `is_eligible_approver()` replaces the old `approval_workflow_projects`-based visibility join (that table is dropped). See [Workflow routing](#workflow-routing--rules). |
| 0028 | Adds `category` as a fourth condition field alongside Class/Supplier/Customer. |
| 0029 | `workflow_change_impacts` — after-save reports of which in-flight bills a step's approver/condition edit affected. See [Workflow change impact reports](#workflow-change-impact-reports). |
| 0030 | Fixes another silent auditor gap: `"invoices: members can insert"` (0001) only ever checked `is_org_member()`, true for auditors too, so an auditor could create a new invoice via manual upload despite the role being documented everywhere else as fully read-only. Adds the missing `is_org_auditor()` exclusion here, plus on `audit_log`/`notifications` inserts for defense in depth. Matching app-layer checks: the upload API route 403s an auditor, `/invoices/new` redirects them, and the dashboard hides "+ Add invoice" for the role. |
| 0031 | `vendor_name_normalized` generated column on `invoices` — DB-side normalized vendor matching (mirrors the app's `normalizeForMatching`). |
| 0032 | **QuickBooks Online connection**: `qbo_connections` (tokens per org, admin-only RLS), plus `qbo_bill_id` / `qbo_sync_status` / `qbo_synced_at` / `qbo_error` on invoices. |
| 0033 | **Accounting-instructions thread**: `accounting_instructions` becomes an append-only thread (author + body + timestamp), the whole thread becomes the QBO bill memo on sync. |
| 0034 | `qbo_categories` — read-only mirror of the QBO Chart of Accounts. |
| 0035 | `qbo_tax_rates` + `qbo_tax_codes` — read-only mirrors of QBO tax rates and the codes (H/G/P/…) with their resolved rates. |
| 0036 | `qbo_classes` — read-only mirror of QBO classes. |
| 0037 | `qbo_suppliers` — read-only mirror of QBO vendors. **Hard rule: Flow never creates suppliers.** |
| 0038 | `qbo_categories.acct_num` — categories display/resolve as "5-15450 - HVAC" (number + name). |
| 0039 | **`qbo_ready` status** — the admin-only final gate. A bill completing every workflow step lands in `qbo_ready` (not `approved`) until an admin presses the final Sync button. |
| 0040 | `qbo_tax_codes.rate_value` — stores each tax code's resolved purchase-side rate (H → 13%). |
| 0041 | `invoices.qbo_vendor_matched` — flags invoices whose OCR'd vendor did NOT exactly match a QBO supplier (visible warning; can't sync until fixed). |
| 0042 | `invoices.has_cos_or_extras` — CO/Extras flag decided by an approver and LOCKED once set; line items get class "Extras" (feature removed 2026-08-27, column dropped by 0065 — see the CO/Extras section below). |
| 0043 | (user) `invoices.qbo_tax_liability_account` — QBO tax liability account on the bill; superseded by 0044. |
| 0044 | (user) Drops the tax liability account column from 0043. |
| 0045 | (user) `invoice_line_items.qbo_tax_code_id` — line-level QBO tax code for the bill sync. |
| 0046 | (user) Supplier settings: `product_service` on `supplier_defaults` (feature reverted 2026-08-27, column dropped by 0064 — see the Settings → Suppliers section below), `integration` on `qbo_suppliers`. |
| 0047 | (user) Fixes `supplier_defaults.vendor_name_normalized` — dropped/re-added with an extra outer `trim()` to match `normalizeForMatching()` exactly. |
| 0048 | `organizations.default_tax_rate` (ingest fallback when the supplier has no rule) + `invoices.totals_note` (document-vs-line-items reconciliation note). |
| 0049 | `qbo_sync_log` (per-org per-section "last synced" times) + `first_seen_at` on `qbo_classes`/`qbo_categories`/`qbo_suppliers`/`projects` (identifies items new in the latest sync). |
| 0050 | `organizations` UPDATE policy for admins — without it RLS silently rejected the default-tax-rate save (the action also now checks the update result). |
| 0051 | `organizations.inbound_email_local` — friendly per-org capture-address local part (`fluid@flow.ufirst.co` instead of a token), unique + validated. |
| 0052 | `inbound_email_log.pending_split_ids` — links an email to the split-review it produced. |
| 0053 | `inbound_email_log` DELETE policy for admins (✕ per entry on the Queue page). |
| 0054 | `upload_log` — durable record of every manual upload (outcome, invoice/split link, error, `created_at → processed_at` timing) for the Recent uploads list and future OCR/queue reporting; 90-day auto-cleanup. |
| 0055 | `ingest_jobs` — async ingestion queue (staging file, status, 3-try retry); `upload_log` gains `queued`/`processing` statuses; `inbound_email_log.processing` for in-flight display. |
| 0056 | Storage UPDATE policy on the `invoices` bucket — fixes "new row violates row-level security policy" when Reorder pages replaces the stored PDF in place. |

---

## Session log — 2026-08-24 (handoff notes)

Everything below was done in one long working session (user + AI pair). The
DB is LIVE (Supabase project `dmndiltwospjeeydmwxd`, org Ufirst
`9554c95f-03f3-4a67-a784-7a138510be7b`); the app deploys automatically from
GitHub `main` (Vercel). **Migrations 0049–0054 are all APPLIED to the live
DB.** This section is the continuation handoff — read it before changing
anything.

### Config state (Vercel production env + `.env.local`)

| Variable | Value / note |
|---|---|
| `INBOUND_EMAIL_DOMAIN` | `flow.ufirst.co` (the Resend receiving domain) |
| `INBOUND_EMAIL_WEBHOOK_SECRET` | random hex (`6ffe5524e8…` on 2026-08-24) — **must match** the `?token=` in the Resend webhook URL |
| `RESEND_API_KEY` | **Full access** key (receiving scope needed) created in the SAME Resend account that owns `flow.ufirst.co` receiving |
| QBO vars | Production Intuit app credentials + `QBO_REDIRECT_URI=https://flow.ufirst.co/api/qbo/callback` — do NOT overwrite with the localhost dev keys in `.env.local` |

Resend receiving is fully wired: domain `flow.ufirst.co` verified for send +
receive, MX record `inbound-smtp.us-east-1.amazonaws.com` priority 10 (added
via the Resend↔Cloudflare integration), and a **Webhooks** entry (not a
"Receiving" section — that's where Resend puts it) for the `email.received`
event POSTing to
`https://flow.ufirst.co/api/webhooks/inbound-email?token=<INBOUND_EMAIL_WEBHOOK_SECRET>`.

### Inbound email (Resend) — the critical path gotcha

The webhook is **Resend-format, not SendGrid**: it receives a JSON
`email.received` event (metadata only — no bodies/attachments), then pulls
attachments from the Resend API. **The received-email APIs live under
`/emails/receiving/{email_id}/attachments`** — the plain `/emails/{id}` path
is for SENT emails and returns `404 Email not found` for received ones (that
bug cost a long debugging session). `listResendAttachments()` in the webhook
also retries 3× with 2s backoff and logs the raw response + email_id on
failure, because Resend can still be indexing the email when the webhook
fires. Resend receives **any** address at `flow.ufirst.co`; attribution is by
local part = `organizations.inbound_email_local` (friendly, e.g. `fluid`)
or the fallback `inbound_email_token`.

### Queue / reporting system (new)

- **Queue page** (`/queue`) — one newest-first list of everything that came
  in: manual uploads (`upload_log`) and inbound emails
  (`inbound_email_log`), with status chips (Processed / Split review /
  Unmatched / Failed / No invoice), invoice links, filter tabs (Pending
  default / All / Processed / Failed), and admin controls (✕ per entry +
  **Clear completed**). Dashboard header has a solid-blue **Queue** button
  next to **+ Add invoice**; sidebar has a Queue link.
- **Add invoice page** — live upload queue (multi-file, sequential) with
  per-file status (Waiting/Processing/Done/Split review/Rejected + reason),
  no auto-redirect, plus a DB-backed **Recent uploads** list (last 20).
- **`upload_log`** records every upload outcome + processing time (future
  OCR/queue metrics). **90-day auto-cleanup** runs opportunistically in the
  upload route and email webhook; admin ✕ / Clear completed keep queues short.
- Queue cleanup actions (`clearCompletedQueue`, `deleteInboundEmailLog`,
  `deleteUploadLogEntry`) are admin-only and rely on the 0052/0053/0054 RLS
  policies.

### Email-attachment merge

An email with several PDF/image attachments is **merged into ONE document**
(in attachment order) and ingested as a single invoice — the in-app
replacement for merging files in macOS Preview (`src/lib/merge-documents.ts`,
mupdf `graftPage`; images convert to PDF pages). If the merged document
actually contains several invoices, the existing split-review flow catches it.
Merge failure falls back to per-file ingestion with a logged note.

### Page reorder (no external tool)

Bill panel → **Reorder pages…** opens a modal (page list with ↑/↓) → Apply
rebuilds the PDF via mupdf (`reorderPdfPages`), re-uploads in place, and
re-extracts from the new page order. Actions: `getInvoicePageCount`,
`reorderInvoicePages` (admin/reviewer only). Invalid orders (non-permutations)
are rejected.

### Totals + class rules (hard rules, enforced at ingest and re-extract)

- **Line items win, not the document** (reversed 2026-08-27 — this bullet
  originally said the opposite: "when line items differ from the printed
  total, the printed total is used." That was wrong and has been undone —
  **do not reintroduce it.**). `invoices.amount`/`tax_amount` are ALWAYS
  what the line items actually add up to (`computeLineItemTotals`) — never
  silently swapped for the document's printed total. When they disagree,
  `totals_note` is purely a warning telling the reviewer to go fix the
  line items (a missing line, a wrong amount); once fixed, the derived
  total naturally converges with the document's and the note clears on
  its own. Unchanged: when the printed total **couldn't be read at all**,
  an amber note says the amount was derived from line items and must be
  verified (catches invoices like Stephenson's where `total_amount` came
  back null).
- **Class NEVER comes from the document** — line items ingest with a blank
  class (`supplierDefaults?.class ?? null`); re-extract also strips document
  classes, preserving only a line's own CON/CO tag if it already has one.

### Performance: org-static caching (do not break the invalidation contract)

`src/lib/org-cache.ts` wraps org-static reads in `unstable_cache` (admin
client inside, keyed by org id, 1h safety TTL):

- `getCachedQboCategories/Suppliers/Classes/TaxRates/TaxCodes` — tag
  `qboTag(orgId)`, invalidated by the six sync actions + `refreshQboData`
  (`revalidateTag(qboTag(org.id))`).
- `getCachedMemberRoster` — tag `membersTag(orgId)`, invalidated by
  invite/remove/role-change in the settings page.
- `getCachedInvoiceList` (invoices + approved-pairs + line-item
  class/category lookups) — **global tag `INVOICES_TAG`** invalidated by
  EVERY invoice-mutating action: all 28 `revalidatePath("/dashboard")`
  sites in `dashboard-actions.ts`, the upload route, the email webhook, and
  pending-split confirmation. **Any new code that creates/edits invoices
  MUST `revalidateTag(INVOICES_TAG)` or the list will be stale up to 10 min.**

### Async ingestion (0055) — done 2026-08-24

Extraction moved OFF the request path:

- **`ingest_jobs`** queue table (staging file + status queued/processing/
  done/error + attempt_count, 3-try retry back to `queued`).
- **Uploads return instantly** (`202 { jobId }`): file → staging → queued
  row + `upload_log` row (`queued`/`processing` → worker completes it to
  done/split/error).
- **Emails return instantly too**: webhook downloads + merges, records
  `inbound_email_log` with `processing=true`, enqueues, returns. Worker
  completes the log row (invoice/split ids, processed, error).
- **Worker** = `src/lib/ingest-queue.ts` `runNextIngestJob()` called by the
  UI's `ExtractionPoller` (mounted on dashboard, Add invoice, Queue) via
  `GET /api/ingest/process` — one job per call, then `router.refresh()`.
  Jobs wait while nobody has the app open (accepted Hobby tradeoff);
  swapping in Vercel Cron / Inngest = call `runNextIngestJob` from a
  scheduled job. `revalidateTag(INVOICES_TAG)` after each job.
- The Queue / Recent uploads show "Processing" chips for in-flight items.
- **Still sync (noted follow-ups):** split-confirmation and the manual
  Re-extract / Reorder-pages actions still run extraction inline.

### Pending / next (in rough order)

1. Invoice-list pagination/virtualization once past a few thousand rows.
2. Settings page could use the org-cache getters too (it still fetches tax
   codes fresh).
3. Make split-confirmation + Re-extract/Reorder async through the same
   ingest_jobs queue.

(The "re-extract should recompute totals_note" item that used to be here is
done — `recomputeInvoiceTotals` in `dashboard-actions.ts` now reruns the
note logic after every line-item add/edit/delete, not just at ingest.)

---

## Session log — 2026-08-26 (QBO sync + Suppliers + UI fixes)

A separate long session (user + AI pair), overlapping with the 2026-08-24 work
above — some of this landed via `git pull` mid-session and merged in cleanly.
**Migrations 0043–0047 are all APPLIED to the live DB.** Read this before
touching `syncToQbo`, `Combobox.tsx`, or the invoice list/document-split layout.

### QBO Bill sync — several real bugs found via live retries

No QBO connection exists in local dev, so every fix here was verified by the
user retrying a real sync on `flow.ufirst.co` and reporting the next error —
each one was a genuine, different bug, not the same issue recurring:

- **`DetailType` typo**: was sending `AccountBasedExpenseDetail`, QBO expects
  `AccountBasedExpenseLineDetail` (found by the user).
- **`AcctNum` isn't queryable** in QBO's API (`where AcctNum = '...'` → error
  4001). Numbered categories ("5-15450 - HVAC") now resolve against the
  already-synced `qbo_categories` mirror instead of a live query —
  `matchCategoryAccount`/`resolveCategoryAccount` in `src/lib/qbo.ts`, refresh-
  on-miss (once per bill), hard failure (never a guess) if still unresolved.
- **Sales tax**: do NOT manually post a "Tax" expense/liability line (tried and
  reverted — migrations 0043/0044 add then drop
  `qbo_connections.tax_liability_account_id`). QBO calculates and posts tax
  itself once a line carries a native `TaxCodeRef`. `resolveTaxCode`/
  `matchTaxCode` resolve a line's selected rate to a QBO tax code via the
  `qbo_tax_codes` mirror — but **two codes can share a rate** (this org has
  "H" and "M&E (ON)" both at 13%), so `invoice_line_items.qbo_tax_code_id`
  (migration 0045) now stores the exact code picked, not just the resolved
  %. The Tax field's `Combobox` submits the code id as `value` and the rate
  as a `secondaryValue` (see `secondaryName` prop on `Combobox`) so the box
  still *displays* "13" while submitting the unambiguous id.
- **Class and Project were never sent to QBO at all** — `createBill` had no
  `ClassRef`/`CustomerRef` handling, and `syncToQbo` wasn't even selecting
  `class`/`project_id` from the line items. Both fixed; Project→QBO Customer
  id is a direct lookup (`projects.qbo_id`, already stored), not a name match.
- **Attachments silently never landed**: `attachDocuments`'s multipart upload
  sent the JSON metadata part as a bare string (defaults to `text/plain`) —
  QBO can't parse that, drops the file, and still returns 200. Fixed by
  sending it as a `Blob` typed `application/json`. Also now checks
  `AttachableResponse[].Fault` per file (QBO can 200 with a partial failure)
  and treats an attachment failure as a **warning**, not a sync failure — the
  Bill already exists in QBO by that point, so failing the whole sync would
  invite a retry that creates a duplicate bill.
- **Vendor matching was exact-only** and errored on trivial spelling
  differences (OCR'd "ONYX-FIRE PROTECTION SERVICES INC." vs QBO's
  "Onyx-Fire Protection Services"). `matchSupplier` now falls back to
  stripping a trailing business suffix (Inc/LLC/Ltd/Corp/Co/…) from both
  sides — only resolves if that narrows to exactly one supplier, never
  guesses between candidates.
- **`vendor_name_normalized` had a real bug**: the generated-column SQL
  expression didn't `trim()` after collapsing punctuation, so a name ending
  in punctuation ("Marsil Mechanical Inc.") produced a value with a trailing
  space that never matched `normalizeForMatching()` (the JS version, used
  everywhere else) — a saved supplier rule for such a name silently never
  applied. Migration 0047 drops and re-adds the column with the fix; found
  while bulk-seeding supplier defaults, which also surfaced that two
  `qbo_suppliers` rows can collapse to the same normalized name (e.g. "X
  Inc" and "X Inc.") — real, separate QBO vendors; only one gets a
  `supplier_defaults` row, the other inherits it via the shared normalized key.
- **Bill `DocNumber` was never set** — `createBill` didn't map
  `invoices.invoice_number` onto it at all; every synced bill showed a blank
  bill number in QBO regardless of tax.
- Admin **"Undo sync"** button (next to "Clear error") lets an admin re-push a
  bill after fixing something — clears Flow's own sync record only, does
  **not** touch/void the Bill already in QBO (re-syncing without deleting the
  old one there creates a duplicate — the button says so).

### Settings → Suppliers (new page)

`/settings/suppliers` — one row per synced QBO vendor (Name, invoice count,
Integration, Category, Class, Tax rate, Currency, Payment terms), every
field auto-saving on blur like a bill's line items. Suppliers are one-way
from QBO (never created here); a new one shows up after the next "Sync
suppliers" and is immediately configurable. This page and the Bill panel's
"Supplier rules" modal call the **exact same** `saveSupplierDefaults`
action (now takes `invoiceId: string | null`) against the exact same
`supplier_defaults` row, so editing either one keeps both in sync by
construction. `class` is a real supplier default; it used to be
deliberately excluded ("a per-bill choice") — reversed per an explicit ask,
since class drives this org's workflow routing.
`qbo_suppliers.integration` (migration 0046) is informational only — every
supplier is QBO today; nothing reads it yet, it's there for whenever a
Xero/Zoho Books connection exists to pick between.

**`product_service`** (`supplier_defaults.product_service`, migration 0046;
`invoice_line_items.product_service`, migration 0063) was built out fully —
Settings, the Supplier rules modal, the Bill panel's line items, ingestion,
re-extraction, clone — then explicitly reverted on 2026-08-27: the org
manages this entirely through Category and doesn't need a separate field.
Both app code AND the DB columns themselves are gone (migration 0064 drops
both — confirmed empty on every row first, so nothing was lost). **Do not
re-add a Product/Service field anywhere in this app without checking with
the user first.** This is unrelated to
`approval_workflow_rules.rule_type = 'product_service'` (see the Workflow
rules section below), which is a genuinely separate, still-active feature
that matches against line item *descriptions*, not this field.

### `Combobox.tsx` — two real bugs, one intentional new mode

- **Picking an option could save the typed search text instead of the picked
  value** (e.g. search "elec", click "Electrical", what actually saves is
  literally `"elec"`). Root cause: for plain-string option lists (Category,
  Class, Supplier name — no `{value,label}` pairs), the *visible* `<input>`
  is the field that submits, and `pick()` called `setQuery(...)` then
  synchronously fired the form submit in the same handler — React batches the
  state update, so the DOM still held the old text when the form read it.
  Paired options (Project, Tax) already dodged this via a hidden input
  written directly by ref, bypassing React's render cycle; the fix extends
  that same synchronous-DOM-write treatment to the visible input itself via
  a new `queryInputRef`. **If you find another oddly-truncated saved value
  anywhere, it's very likely a pre-fix relic — just re-pick it.**
- **`wrapWhenIdle` prop** (opt-in, default off): Category and Project values
  used to truncate with "…" when their column narrowed, silently hiding part
  of the value — same complaint as the Description-clipping bug below, but
  these are `<input>`-backed (via Combobox) and inputs can't wrap. When
  `wrapWhenIdle` is set and the field isn't actively focused, it renders the
  current value as a wrapped, auto-height `<div>` instead of the single-line
  input; clicking it swaps back to the normal search input. Only Category
  and Project opt in — every other Combobox in the app is untouched. For
  plain-string options a hidden stand-in `<input>` carries the submitted
  value while idle (the real input isn't mounted then).

### Layout: document 50/50 split, scroll fixes

- Opening a document now splits the bill panel to exactly half the available
  width (floored at 600px so it doesn't get too cramped on a small screen)
  and **hides the sidebar and invoice list entirely** (not just their usual
  collapsed rail) via a new `DocumentFocusContext` — both come back exactly
  as they were on close. `DetailSplit`/`Sidebar`/`CollapsiblePane`.
- The invoice-list line-item Description box could get clipped when its
  column narrowed for any reason (the 50/50 split, a manual panel resize) —
  its auto-resize only re-ran when the *text* changed, not the *width*.
  Fixed with a `ResizeObserver` on the row.
- Invoice list scrolling to the top on every click took **two** attempts:
  `scroll={false}` on the row `Link` wasn't enough — Next.js resets nested
  scrollable panes on navigation too, not just the window, apparently
  strongly enough to survive that prop. Fixed the same way
  `ScrollPreserveForm` already fixed this for Settings' buttons: save
  `scrollTop` to `sessionStorage` on scroll, forcibly reassert it on every
  render (now, next frame, +100ms) in `CollapsiblePane`.

### Bill panel: vendor email + QBO vendor link

`invoice.source_email` is genuinely "who emailed this into Flow" (an AP
inbox, a forwarder) — never the vendor's own email, which was always sitting
unused in `invoices.extraction.vendor_email` (OCR'd, no dedicated column).
The Email field under Vendor name now shows/edits that instead, with a
mailto: link. "Open vendor in QuickBooks Online" sits right under the picked
vendor name (resolved server-side the same way sync matches suppliers).

### Line-item cells: bottom-aligned, full-column hover/click target

Follow-up round on the same table, driven by the user clicking through the
live UI and iterating live (unlike the rest of this session's UI work, this
round **was** confirmed working against real data — bill with a wrapped
Description, e.g. "MR6010 FENCE, 6' X 10' TEMP./FT"):

- Category/Description/Project/Class/Tax/Amount used `items-start` on the
  row's grid, so an *empty* field's underline sat up near the row's first
  line instead of near its own bottom divider — most visible once
  Description wraps to 2+ lines and the row grows taller than the other,
  single-line cells. Switched the row to `items-end`; checkbox/action-icon
  padding flipped from `pt-*` to matching `items-end` handling.
- That alone made the underline hug the bottom correctly for a normal
  1–3 line row, but it also meant the *hoverable/clickable area* was still
  just that field's own small content-height box, now sitting at the very
  bottom of a possibly much taller row — easy to miss, and for a long
  Description effectively required scrolling to find. **First attempted
  fix (capping Description's height with an internal scrollbar) was
  explicitly rejected by the user** — they didn't want Description
  truncated/scrolled at all; the real ask was "hovering anywhere in the
  column should reveal the line, not just the exact bottom sliver."
- Real fix: `Combobox` (`src/components/Combobox.tsx`) gets a new
  `fillCell` prop (Category/Project/Class/Tax in the line-item row use it;
  Vendor name and other Comboboxes elsewhere don't). Its own wrapper
  becomes a nested single-cell grid spanning the *full* row height
  (`items-end` inside, so the value still sits at the bottom); a
  `group/cell`-scoped hover reveals the underline from anywhere in that
  full-height area, and an `onClick` on the wrapper's dead space (guarded
  by `e.target === boxRef.current`, so it doesn't double-fire when the
  actual input/idle-div handles its own click) focuses the field. Amount
  (a plain `<input>`, not a `Combobox`) gets the identical treatment by
  hand via an explicit wrapper + ref.
- Separately (unconfirmed): picking a Combobox option by mouse click,
  then immediately pressing Tab, was reported to sometimes not land on
  the next field. Root cause unconfirmed — no reproduction found by
  reading the code (focus should already survive the pick via the
  existing `preventDefault()` on the dropdown option's `onMouseDown`).
  Best-effort mitigation added: `justPickedRef` in `Combobox.tsx` restores
  focus to the field once its own autosave round-trip lands, in case the
  page-wide `revalidatePath("/dashboard", "layout")` triggered by that
  save is what's knocking focus away.

### Pending / worth knowing

1. `qbo_suppliers.integration` is stored but not yet used anywhere else (no
   second accounting-platform connection) — see its migration comment (0046)
   before building on it. `product_service` was fully wired end-to-end and
   then explicitly reverted, app layer AND its DB columns both removed
   (migration 0064) — see the Settings → Suppliers section above; **do not
   re-add it.**
2. The Combobox truncation-save bug (fixed above) may have corrupted
   Category/Class/vendor-name values saved before the fix — an audit across
   this org's live data found only the one already-known instance (already
   corrected by hand), but it's worth a periodic glance if something looks
   like a truncated search string instead of a real value.
3. Neither the document 50/50 split nor the Combobox `wrapWhenIdle` mode nor
   the scroll fixes were click-tested in a live browser — no login
   credentials were available in that working environment. Verified via
   `tsc`/`lint`/build + careful reasoning about the exact DOM/layout
   mechanics only. (The line-item cell alignment/hover fix above is the
   exception — that one was confirmed live by the user.)
4. The Tab-after-pick mitigation (above) is unconfirmed — flag it if it
   turns out not to be the actual cause next time it's reported.

### Totals: line items win, not the document (reversed, then re-reversed)

Same day, later in the session: the pre-existing "document total wins"
design (2026-08-24 section, `### Totals + class rules`) got reversed here
twice in a row before landing on the right answer — both invoices.ts's
ingestion logic and dashboard-actions.ts's `recomputeInvoiceTotals`.

1. First found: `invoices.amount`/`tax_amount` were being silently
   substituted with the document's OCR total whenever line items
   disagreed — but the Bill panel's own summary always showed the LIVE
   line-item sum instead, directly contradicting `totals_note`'s claim
   ("the document total was used" next to a number that wasn't).
2. First fix attempt: made the summary prefer the reconciled/document
   figures on load. **Wrong** — explicitly corrected: the user's actual
   workflow depends on the live total NOT being silently swapped. Editing
   line items should show the real, current math; if it disagrees with
   the document, that mismatch IS the signal to go find the mistake (a
   missing line, a wrong amount) — not something the app should paper
   over with a substituted number.
3. Final, correct design: `invoices.amount`/`tax_amount` (and the Bill
   panel's Subtotal/Tax/Total) are now ALWAYS `computeLineItemTotals`
   applied to the actual current line items — full stop, no substitution,
   ever. `totals_note` is purely a warning when that live total disagrees
   with `document_total`; fixing the line items makes it converge and the
   note clears on its own (recomputed on every add/edit/delete via
   `recomputeInvoiceTotals`, not just at ingest).
4. Real example that surfaced this (invoice 26-2422, Ridgeline Electric):
   OCR extracted 6 of 8 line items at $0.00 (a schedule-of-values table it
   didn't fully parse) plus a "10% HB" holdback line with `tax_rate: null`
   instead of matching the contract line's 13%. The user deleted the six
   $0 lines by hand; once the holdback line was corrected to 13% too,
   subtotal 25,001.28 + tax 3,250.17 = 28,251.45 — exactly the document's
   own total. **Do not reintroduce document-substitution logic** — the
   live-math-plus-warning-note design is deliberate, not an oversight.

### Full-codebase audit + 9 fixes, CO/Extras removed entirely

Same day: a requested "audit line by line" pass (4 parallel finder agents
+ verification) surfaced 10 confirmed correctness bugs; see git log for
`Fix 9 confirmed bugs from full-codebase audit`. Two worth calling out
beyond their commit messages:

- **Bill panel not remounted per invoice** (`BillPanel.tsx`/
  `DetailSplit.tsx`) was the most severe: switching invoices in the
  sidebar left stale uncontrolled-input values on screen (Bill date, Due
  date, Bill number, Vendor, Email) that could silently overwrite the
  newly-selected invoice on the next blur. Fixed by keying each field to
  `invoice.id` — NOT by keying the whole panel/DetailSplit tree, which
  would also reset unrelated state (the open document viewer, in-progress
  line-item selections) on every navigation.
- **Re-extract still substituted the document total** in
  `extract-invoice.ts`'s `mapExtractionToInvoice` — the "line items win,
  not the document" fix two sections up only touched `invoices.ts`
  (initial ingestion); this separate, re-extract-only function had the
  same old logic and was silently reintroducing the bug. Fixed to match.

The 10th finding (the CO/Extras auto-stamp NULL-matching bug) was
**skipped, then the whole feature was removed** instead — see the CO/Extras
section above.

---

## Environment variables

Copy `.env.example` → `.env.local` and fill in:

| Variable | Required | Where it comes from |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Same page → **Publishable key** (new naming) / anon key (legacy naming) — safe to expose client-side |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Same page → **Secret key** (new naming) / service_role key (legacy) — **server-only, full admin access, never expose to the client** |
| `INBOUND_EMAIL_WEBHOOK_SECRET` | Yes (for email ingestion) | Any random string you choose; appended as `?token=` on the webhook URL you give Resend |
| `INBOUND_EMAIL_DOMAIN` | Yes (for email ingestion) | The receiving domain added to Resend, e.g. `flow.ufirst.co` |
| `OPENROUTER_API_KEY` | For extraction | openrouter.ai — required for invoice field/line-item extraction (without it, extraction silently no-ops rather than failing ingestion) |
| `OPENROUTER_MODEL` | No | Any OpenRouter model id, e.g. `anthropic/claude-sonnet-4.5`, `openai/gpt-4o`, `google/gemini-2.0-flash-001` — defaults to `anthropic/claude-sonnet-4.5`. This is the knob for testing extraction quality across models. |
| `QBO_CLIENT_ID` | For QBO sync | Intuit Developer app client id (developer.intuit.com) |
| `QBO_CLIENT_SECRET` | For QBO sync | Intuit Developer app client secret |
| `QBO_REDIRECT_URI` | For QBO sync | Must match the app's registered Redirect URI exactly, e.g. `http://localhost:3210/api/qbo/callback` |
| `RESEND_API_KEY` | Yes (for email ingestion + mentions) | resend.com — required for inbound attachments and for @mention notification emails; without it, inbound ingestion can't fetch attachments and mentions still create the in-app `notifications` row, just no email |
| `RESEND_FROM_EMAIL` | No (required if `RESEND_API_KEY` is set) | Must be a verified sender/domain in your Resend account |

Supabase renamed its API keys at some point — you may see either
**"Publishable and secret API keys"** or **"Legacy anon, service_role API
keys"** on the API settings page. Both work identically for this app; just
match publishable→anon and secret→service_role.

---

## Local development

### First-time setup

```bash
npm install
cp .env.example .env.local   # then fill in the values above
```

1. **Create a Supabase project** at supabase.com.
2. **Run all 30 migrations**, in order — paste each file in
   [`supabase/migrations/`](supabase/migrations/) into the SQL editor and
   run it (`0001` through `0030`), or `supabase db push` if you have the CLI
   linked. All of them are idempotent — safe to re-run.
3. **Create the storage buckets**: Storage → New bucket → `invoices`
   (Public **off**) and `avatars` (Public **on**) — or let migration 0016
   create `avatars` for you via the SQL editor; `invoices` needs the same
   treatment from 0001.
4. **Run the dev server** — see below.
5. **Bootstrap your first org and user** — see [First org setup](#first-org-setup).

### Running the dev server

The dev server is pinned to a **fixed port, 3210**, via
[`.claude/launch.json`](.claude/launch.json) (`next dev -p 3210`). This
matters because Supabase magic-link/password redirects, and the Resend
webhook URL you register, all hardcode an origin — a random port on every
restart would break those. If you're not using the Claude Code preview
tooling, just run:

```bash
npm run dev -- -p 3210
```

Note: port 3000 was already in use by something else on the dev machine when
this was set up (unrelated to this project) — 3210 was picked as a free
port. Change it in `.claude/launch.json` (or drop `-p 3210` entirely) if
that's no longer true on your machine.

### First org setup

There is no signup/invite UI yet (see [What's not built
yet](#whats-not-built-yet)) — but once you have one admin bootstrapped via
SQL, [Settings](#settings) can invite everyone else.

1. Sign in once via `/login` (password or magic link — see [Authentication](#authentication)) so the user exists in `auth.users`.
2. In the Supabase SQL editor:

```sql
insert into organizations (name, slug) values ('Acme Inc', 'acme') returning id;

insert into profiles (id) values ('<your auth.users id>') on conflict do nothing;

insert into organization_members (organization_id, user_id, role)
  values ('<org id above>', '<your auth.users id>', 'admin');

insert into approval_workflows (organization_id, name, is_default)
  values ('<org id above>', 'Default', true) returning id;

insert into approval_workflow_steps (workflow_id, step_order, name)
  values ('<workflow id above>', 1, 'Approval') returning id;

-- Make yourself the step's default approver (the fallback used when no
-- conditional approver's Class/Category/Supplier/Customer rules match —
-- see Workflow routing below). With no other approvers on the step,
-- you're eligible for every invoice on this workflow.
insert into approval_workflow_step_approvers (step_id, approver_user_id, is_default)
  values ('<step id above>', '<your auth.users id>', true);
```

Find your `auth.users` id in Supabase → Authentication → Users, or via
`supabase.auth.admin.listUsers()` with the service role key.

---

## Authentication

`/login` supports two methods:

1. **Magic link** (`signInWithOtp`) — the intended production flow. Uses
   Supabase's **PKCE** flow by default (`@supabase/ssr`'s browser client sets
   `flowType: "pkce"`), so the emailed link redirects to
   `/auth/callback?code=...`, which exchanges the code for a session
   server-side ([`src/app/auth/callback/route.ts`](src/app/auth/callback/route.ts)).
2. **Email + password** (`signInWithPassword`) — added as a reliable
   fallback for local testing. Set a password for a user via
   `supabase.auth.admin.updateUserById(id, { password })` with the service
   role key.

There's also [`src/app/auth/confirm/route.ts`](src/app/auth/confirm/route.ts),
which handles Supabase's alternate `token_hash` + `type` email-confirmation
format (its documented pattern for customizing email templates, and also
what `supabase.auth.admin.generateLink()` returns) — separate from the
`?code=` PKCE flow that `/auth/callback` handles.

**Known gotcha (local dev):** Supabase's built-in email sending has a low
rate limit (a handful of emails/hour) — you'll hit "email rate limit
exceeded" quickly while iterating. Options:
- Use the password sign-in instead (no email involved).
- Configure a custom SMTP provider in Supabase Auth settings to lift the limit.
- Generate a one-time link server-side via `supabase.auth.admin.generateLink()`
  and open it directly — bypasses sending, but **be careful**: these
  single-use tokens can get silently consumed by browser link-prefetching or
  URL-preview mechanisms before a human clicks them.
  `/auth/confirm` has a fallback that treats an already-established session
  as success if the token itself fails, which helps but doesn't fully
  eliminate this.

---

## Roles & permissions

Three roles on `organization_members.role`, managed in [Settings](#settings):

| Role | Can see | Can do |
|---|---|---|
| `admin` | Every invoice | Everything — review, approve at any step, manage members/projects/workflows/rules, admin overrides |
| `auditor` | Every invoice | **Read-only** — no edits, no decisions, anywhere (enforced in RLS, not just the UI) |
| `user` | Invoices they submitted, project-less invoices, and invoices where they're an eligible approver on some step of the workflow — i.e. their Class/Category/Supplier/Customer conditions match, or they're a default approver (see [Projects & visibility](#projects--visibility)) | Submit invoices, act as an approver on steps they're eligible for, comment |

`user` never sees invoices still in `on_review` (Review Complete is
admin-only) — enforced by `can_see_invoice()` at the database level, not
just hidden in the UI.

---

## Invoice lifecycle & statuses

Seven statuses (migrations 0017, 0039), matching ApprovalMax's own set plus
the QBO Ready final gate:

```
        Review Complete (admin)
on_review ─────────────────────▶ on_approval ──approve (final step)──▶ qbo_ready
   │                                 │  ▲                                  │
   │                                 │  └── Hold ──▶ on_hold ──Back to Review──▶ on_review
   │                                 │                                      │
   │                                 └── reject ──▶ rejected                 │
   │                                                                         │
   └── Cancel (submitter or admin, from on_review/on_approval/on_hold) ──▶ cancelled
                                                                              │
qbo_ready ── admin presses "Sync to QuickBooks (final)" ──▶ approved (synced)
```

- **`on_review`** — every new invoice lands here regardless of source. An
  admin fixes up extracted fields, then clicks **Review Complete**, which
  re-runs [workflow routing](#workflow-routing--rules) (project/line items
  may now be known) and moves it to `on_approval` at step 1.
- **`on_approval`** — waiting on whoever's assigned to `current_step_order`
  ([admins can reassign](#admin-overrides)). Approve advances to the next
  step or, on the final step, to `qbo_ready`. Reject goes straight to
  `rejected`.
- **`qbo_ready`** — the bill completed **every** step of the workflow and is
  waiting for the **admin-only final release**. It appears on the dashboard's
  **QBO Ready** tab; the admin opens it and presses **"Sync to QuickBooks
  (final)"** — the only path to QBO. On success the status becomes
  `approved`.
- **`on_hold`** — the current approver paused it instead of deciding;
  **Back to Review** (admin) sends it back to `on_review` at step 1,
  resetting decisions but keeping the audit trail.
- **`approved`** / **`rejected`** — terminal. `approved` means the bill was
  synced to QuickBooks.
- **`cancelled`** — terminal; the submitter or an admin can withdraw an
  invoice that hasn't been decided yet.

**Decisions are enforced server-side**, not just hidden in the UI: only the
approver assigned to the current step (or an admin's
[reassignment](#admin-overrides)) can decide, prior steps must already be
approved, and the unique `(invoice_id, step_order)` constraint (0002) makes
double-decisions impossible even under a race. Failures redirect to
`?error=...` and render as a banner in the detail pane.

---

## Invoice ingestion

Both entry points below funnel through
[`ingestInvoiceFile()`](src/lib/invoice-ingest.ts), which classifies the
upload before committing to "this is one invoice" — see [Multi-invoice
split detection](#multi-invoice-split-detection) — and, for the normal
single-invoice case, calls `createInvoiceFromFile()`
([`src/lib/invoices.ts`](src/lib/invoices.ts)) to do the actual work:
upload to Storage, extract fields, apply supplier defaults, route to a
workflow, insert the `invoices` row.

### Manual upload

UI: [`src/components/InvoiceUploadDropzone.tsx`](src/components/InvoiceUploadDropzone.tsx)
(click or drag-and-drop) on `/invoices/new` → `POST /api/invoices/upload`
(authenticated, uses the signed-in user's session) → `ingestInvoiceFile()`.

### Multi-invoice split detection

([`src/lib/invoice-split.ts`](src/lib/invoice-split.ts)) A multi-page PDF
upload might be one invoice plus supporting pages (a PO, packing slip,
T&Cs — handled fine, becomes one invoice with extra documents) or several
completely separate invoices stapled into one file. `ingestInvoiceFile()`
classifies which case it is; if it looks like several invoices, nothing is
created yet — the upload lands in `pending_invoice_splits` for a human to
review at `/invoices/pending-splits`, confirm the page ranges, and create
the resulting invoices (or dismiss it as a false positive). Applies to
both manual upload and email ingestion.

### Email ingestion (Resend Receiving)

The ApprovalMax/Dext model: every org gets a capture address **on our
domain** — `{friendly}@{INBOUND_EMAIL_DOMAIN}`, e.g. `fluid@flow.ufirst.co`
— and the client changes nothing (no DNS, no MX, nothing). They tell
suppliers to email invoices to that address and log in at our app to manage
them.

- Each org has a unique `inbound_email_token`; admins can set a friendly
  `inbound_email_local` in Settings → Integrations → Invoice email. Both the
  friendly local part and the token resolve to the org.
- The webhook (`src/app/api/webhooks/inbound-email/route.ts`) receives
  Resend's `email.received` JSON event (metadata only), then pulls the
  attachments through the Resend API (`GET /emails/{email_id}/attachments`,
  each with a signed `download_url`) and ingests every PDF/image.

**Subject codes (how the office tells the app what to do):** put the code at
the very START of the subject when forwarding — **PDF count FIRST, invoice
count SECOND**. **Brackets are REQUIRED** — `[31] FW: …`, never a bare
`31`. A bare number is never read as a code, so subjects that start with a
real number (invoice # like `26-2403`, amounts, dates) can't be misrouted.
No code = each PDF is its own invoice (the default — never merged).

| Code | Meaning | Action |
|---|---|---|
| *(no code)* | Each PDF = its own invoice | Each file → its own invoice |
| `[X1]` e.g. `[31]`, `[21]` | **X** PDFs = **1** invoice (invoice + backup + certificate) | Combine all into one invoice |
| `[1N]` e.g. `[13]`, `[16]` | 1 PDF containing **N** invoices | Force split review (confirm page ranges) |
| `[NN]` e.g. `[22]`, `[33]` | **N** PDFs = **N** invoices | Each PDF its own invoice (same as no code) |
| `[NM]` | **N** PDFs, each containing multiple invoices | Every PDF goes to split review |

Examples: `[31] FW: Invoice 26-2400` → combine three attachments into one
invoice · `[13] FW: Draws` → one PDF with three invoices → split review.
Emails are processed immediately on arrival (inline in the webhook — no
browser needed); persistent failures are queued for retry and stay
Reprocessable from the Queue page.

**Signature images and non-PDF files never become invoices.** Email
signatures/logos (small images, `logo.*`, Outlook-style `image001.jpg`
inline images) are detected and skipped at the webhook — they used to
create blank junk bills (a logo extracts a vendor name and passed the "not
empty" check). A "no invoice data" rejection now requires the extraction to
have found **no** invoice-defining data (number, totals, tax, PO, or line
items) — a vendor name and/or description alone (e.g. a WSIB clearance
certificate) is not an invoice. Everything skipped (spreadsheets, signature
images) is recorded on the email log row (`skipped_attachments`) and shown
on the Queue page, so no attachment silently disappears from an email.

**Setup (one-time, on the SaaS side — clients do nothing):**
1. Resend → **Domains → Add domain** with the value of `INBOUND_EMAIL_DOMAIN`
   (e.g. `flow.ufirst.co`) and **enable Receiving** for it.
2. Add the MX and verification records Resend shows at your DNS provider
   (a subdomain like `invoices.flow.ufirst.co` is safest — it never touches
   the root domain's mail).
3. Resend → Domains → {domain} → **Receiving → Webhook URL**:
   `https://<your-domain>/api/webhooks/inbound-email?token=<INBOUND_EMAIL_WEBHOOK_SECRET>`.
4. Set `RESEND_API_KEY` (required for inbound now, not just outbound) and
   `INBOUND_EMAIL_DOMAIN` in Vercel and `.env.local`.
5. Forwarding/CC'ing an email to an org's inbound address creates one
   invoice per PDF/image attachment (or queues it for split review — see
   above — if a single attachment looks like several stapled-together
   invoices).
6. Every hit (matched or not, invoice created or not) is logged to
   `inbound_email_log` for debugging.

**Testing the webhook locally** — simulate Resend's JSON event with curl:

```bash
curl -X POST "http://localhost:3210/api/webhooks/inbound-email?token=<INBOUND_EMAIL_WEBHOOK_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"type":"email.received","data":{"email_id":"<a-real-resend-email-id>","from":"vendor@supplier.com","to":["<org_inbound_local_or_token>@<INBOUND_EMAIL_DOMAIN>"],"subject":"Invoice for August services"}}'
```

(Full ingestion of attachments requires a real Resend `email_id` — the
metadata-only event is the production path.)

### Field extraction (OpenRouter, model-agnostic)

[`src/lib/extract-invoice.ts`](src/lib/extract-invoice.ts) sends the
uploaded PDF/image to an **OpenRouter** model (any model — set
`OPENROUTER_MODEL`; this is currently the mechanism for **testing
extraction quality across models**, not a fixed production decision) and
asks for strict JSON covering far more than the basics: vendor
(name/address/email/phone), invoice number, bill date, due date, PO number,
currency, subtotal, tax rate/amount, total, customer, description, **and
every line item** (description, quantity, unit price, amount, category,
class, tax rate). PDFs are rendered to PNG pages via `mupdf` first (vision
models take images, not raw PDF bytes); the raw OCR text rides along as
extra context.

Line items populate the Bill panel's Category details automatically, and
extraction failures resolve to `null` rather than blocking ingestion. **The
invoice's subtotal/tax/total shown in the app are derived from the line
items** ([`src/lib/invoice-totals.ts`](src/lib/invoice-totals.ts): tax is
computed per line as amount × tax rate%, summed) rather than trusted from
the document's own printed total — line items are the thing a human
actually edits, so they're the source of truth once extraction hands off.
A **"Re-extract document fields"** button in the Bill panel re-runs the
engine on the primary document (Dext-style re-process) and replaces the
fields + line items. Requires `OPENROUTER_API_KEY`.

**Supplier defaults win over extraction**: right after extraction runs,
`createInvoiceFromFile()` checks [`supplier_defaults`](#supplier-default-rules)
for a match on the extracted vendor name — if found, Category/Class/Tax
rate/Currency from the saved rule override whatever the model guessed, and
Payment terms computes `due_date` from `bill_date`. These are business
rules a human configured on purpose, so they're treated as more
authoritative than a best-effort read of the document.

---

## Workflow routing & rules

`/workflows` (admin-managed, `user`/`auditor` see it read-only) has **two
separate routing layers** — easy to conflate since both are called "rules"
in the UI, but they answer different questions:

1. **Which workflow does this invoice use?** — the coarse layer, unchanged
   since 0009.
2. **Within that workflow's steps, who actually approves *this* invoice?**
   — the layer migrations 0027/0028 rebuilt, replacing "one approver per
   step" with ApprovalMax-style conditional multi-approver routing. This
   is what makes **one workflow** cover every project/customer instead of
   needing a separate workflow per project (previously each step could
   only name a single approver, so different approvers per
   project/customer meant either linking projects to different whole
   workflows, or maintaining dozens of near-duplicate workflows).

### 1. Which workflow an invoice uses

([`src/lib/workflow-routing.ts`](src/lib/workflow-routing.ts)) — each
**workflow** has a list of **workflow items** (routing rules), evaluated at
Review Complete in workflow creation order: the **first** workflow whose
items **all** match wins; if none match, the org's default workflow is
used. Rule types: `total_amount` (any/between/under/over/equal),
`requester`, `supplier`, `product_service`, `category`, `class`, `customer`
(any/matches/not_matches). `customer` matches against *every* project
touched by the invoice's line items (a bill can split across several — see
[Projects & visibility](#projects--visibility)), not a single field. A
workflow with **no** items matches every invoice — that's how the default
workflow is meant to be configured. In practice most orgs need only one
workflow (see below), so this layer mainly matters once you actually want
different step chains for, say, high-value vs. routine bills.

### 2. Who approves within that workflow — conditional per-step routing

Each workflow has an ordered list of **approval steps** (a `name` and an
`approval_mode`: `all` requires every matching approver on the step to
approve, `any` completes the step on the first approval). A step can have
**several approvers**, each either:

- **Conditional** — eligible only when the invoice matches their own
  AND-ed conditions across up to four fields: Class, Category, Supplier
  (free text — e.g. "does not match Ferrari & Associates Insurance") and
  Customer (picked from real `projects`, matched by project id). Each
  condition can hold several values (OR within that one condition — e.g.
  Class matches "GE" or "HB").
- **Default** — the fallback approver(s) for the step, used only when
  *no* conditional approver's rules match. A step with only a default
  approver behaves like the old single-approver-per-step model.

The admin UI for this is the **"Approval matrix"** modal on `/workflows`
(click a step's approver-count button) — approvers as rows, condition
fields as columns with tag-chip pickers, matching ApprovalMax's own
editor. Matching logic lives in two places kept deliberately in sync:
[`src/lib/workflow-conditions.ts`](src/lib/workflow-conditions.ts)
(`effectiveApproversForStep`, used app-side to decide who sees the
Approve/Reject buttons and who shows as "currently holding" an invoice)
and `is_eligible_approver()` in migration 0027/0028 (the same logic in
SQL, driving RLS visibility). If you change the matching rules, update
both.

---

## Projects & visibility

`projects` (Settings-managed) are org-scoped customers/jobs/classes. Three
separate things depend on them:

1. **Access control** — a `user`-role member can only see an invoice if
   they submitted it, it has no project at all, or `is_eligible_approver()`
   says they'd end up as the effective approver of some step on the
   invoice's workflow — i.e. either they're a default approver on some
   step, or a conditional approver whose Customer condition (among
   others) matches a project the invoice touches. Enforced in Postgres,
   not the UI. (Through migration 0026, this ran through
   `approval_workflow_projects` — "any approver on a workflow linked to
   this project" — a coarser, project-linked model; 0027 replaced it with
   the per-approver-condition check described above, and dropped that
   table.)
2. **Workflow-selection routing** — the `customer` rule type in [workflow
   routing](#workflow-routing--rules), part 1.
3. **Per-step approval routing** — the Customer condition on individual
   step approvers, [workflow routing](#workflow-routing--rules) part 2.

**A bill can split across multiple projects** (migration 0019): Project is
a field on each **line item** (Category details), not a single
invoice-level field — because a real invoice might have some cost going to
Project A and some to Project B. Visibility and both routing layers match
on *any* of the projects an invoice's line items touch (deliberately
permissive — in practice a split only ever happens across projects the
same PM already covers).

---

## Supplier default rules

Dext/ApprovalMax-style: a **"Supplier rules"** link on the Bill panel
(next to the vendor name) opens a modal to save defaults for that supplier
— **Category, Tax rate, Currency, and Payment terms** (days after invoice
date, computes the due date). Class and Project are deliberately NOT part
of a supplier rule: a supplier works on many projects, and class is a
per-bill choice, so those are never auto-filled from a rule.

- **Starts blank** — it never pre-fills from the current invoice or a saved
  rule; only the fields you explicitly pick are saved (blank fields never
  overwrite existing defaults).
- **Searchable pick-lists from the QBO mirrors**: Category (numbered QBO
  accounts — type "hvac" → "5-15450 - HVAC"), Tax (QBO codes — type "h" →
  H 13%). No free-form typing.
- **Matched by normalized vendor name** (trim + lowercase) — there's no
  first-class Supplier entity yet, same matching used for [duplicate
  detection](#document-search) and the Document Search Supplier filter.
- **Applied automatically at ingestion**: every future invoice from that
  vendor picks up the rule the moment it's created (see [Field
  extraction](#field-extraction-openrouter-model-agnostic)) — nothing to
  click per invoice.
- **"Apply to all invoices still in review from this supplier"** (checked
  by default): retroactively pushes the new rule onto every other
  `on_review` invoice from that vendor, not just future ones.

---

## Document search

A **Filters** button in the dashboard header opens an ApprovalMax-style
advanced search panel
([`src/components/DocumentSearchModal.tsx`](src/components/DocumentSearchModal.tsx)):
multi-select fields (pick several values — "vendor A OR vendor B" — shown
as an "N values" pill, same interaction pattern as ApprovalMax's own) for
**Currently holding**, Requester, Approved by, Status, Supplier, Customer,
Class, plus Invoice number and Bill date/Amount ranges. Multi-selects
support search-within-list (built for hundreds of suppliers, not just a
handful) and a "select all matching" row.

**"Currently holding"** — who has the document right now, resolved from
`approval_workflow_steps` + `current_step_order` (or an [admin's
reassignment](#admin-overrides)) — is a field ApprovalMax's *own* search
screen doesn't have (it only offers Requester and Approved by); shown both
as a filter and directly on each invoice row/detail view.

**Possible-duplicate detection**: computed live (not stored) across
non-cancelled/rejected invoices from the same normalized vendor with the
same invoice number. Any invoice in a duplicate group gets an orange
left-border marker in the list, and **every group is pinned together at
the top of the list pane** (in front of the normal filter/sort order) so
the matches are visible without having to hunt for them; opening one also
shows a banner linking to the others, noting a differing amount as a
likely price-corrected resubmission rather than a true duplicate. Purely
informational — nothing is auto-blocked or auto-linked.

---

## Admin overrides

Two admin-only controls in the "Status & approval" section of the detail
pane:

- **Reassign to** — pushes *one specific invoice* to a different approver
  for its current step, without touching the shared
  `approval_workflow_steps` template (which would silently reassign every
  other invoice on that workflow too). Stored on the invoice itself
  (`step_override_approver_id`), auto-clears once that step is decided or
  the invoice leaves `on_approval`/`on_hold`.
- **Override status** — force-sets status to any of the 6 values directly,
  bypassing the normal step-by-step gate. Doesn't fabricate an
  `invoice_approvals` row for whatever step got skipped (that would
  misrepresent who actually decided it) — the `audit_log` entry
  (`invoice.admin_override_status`, with from/to) is the honest record.

**Reassign to** is also the escape hatch for a real edge case in the
conditional routing model ([Workflow routing](#workflow-routing--rules)):
a step with only conditional approvers and no default fallback can end up
matching *nobody* for a given invoice — e.g. an approver's Category
condition, and the invoice's line items just don't carry that category. An
`on_approval` invoice stuck this way shows an explicit amber warning in
Status & approval (rather than the normal, silent "Waiting on the
approver" message) telling an admin it can't be approved as-is, and
pointing at Reassign to (which bypasses conditions entirely) as the fix —
alongside the longer-term fix of adding a default approver or correcting
the step's conditions in `/workflows`.

---

## Workflow change impact reports

Deliberate design choice, not a missing feature: **there is no "restart
the workflow" step.** ApprovalMax snapshots a workflow onto a bill when it
enters approval, so editing the workflow later doesn't affect bills
already in flight until you explicitly restart them — and restarting
resets the audit trail, forcing the whole approval process to be redone.
Approval Flow never snapshots anything: `effectiveApproversForStep()` /
`is_eligible_approver()` are recomputed live from the current workflow
definition on every read and decide, so a step edit takes effect on every
in-flight invoice at that step **immediately** — nothing to restart, and
nothing ever wipes `invoice_approvals` or `audit_log`.

The tradeoff: a step edit *can* silently strand an in-flight bill (its
previously-eligible approver no longer matches, no default to fall back
to — see [Admin overrides](#admin-overrides) above). Rather than gate
saves behind a confirmation prompt, the blast radius is reported **after**
the save: `saveStepApprover`/`deleteStepApprover`
([`src/app/workflows/page.tsx`](src/app/workflows/page.tsx)) snapshot the
step's approvers/conditions before and after the edit, and
[`recordStepChangeImpact()`](src/lib/workflow-impact.ts) re-evaluates
`effectiveApproversForStep()` against every `on_approval`/`on_hold`
invoice currently sitting at that step, both ways. Any invoice whose
required-approver set changed gets written to `workflow_change_impacts`
(migration 0029) and shown as a dismissible amber banner at the top of
`/workflows` — who it was with before, who it's with now (or "nobody —
needs reassignment"), linking straight to each affected invoice.
Admin-only (`is_org_admin` RLS); dismissing just sets `dismissed_at`, it
doesn't delete the row.

---

## Dashboard UI

`/dashboard/[[...id]]` ([`src/app/dashboard/[[...id]]/page.tsx`](src/app/dashboard/[[...id]]/page.tsx))
is a master-detail interface, all server-rendered:

- **Sidebar**: org name + inbound email address, and nav filters computed
  from real data — All invoices, Pending Review (admin/auditor only),
  **Requires my approval**, Created by me, Approved, Rejected. Each shows a
  live count.
- **Search**: a quick text box (`?q=`, vendor/file/invoice #) plus the full
  [Document search](#document-search) panel for everything else.
- **List pane**: clicking a row navigates to `/dashboard/[id]?...` (filters
  preserved in the query string), which server-renders the detail pane.
  Admin users get a **checkbox per row**; with one or more selected a
  **batch action bar** appears (sticky at the top of the list):
  - **Delete** — removes the selected invoices + their documents (two-step
    confirm; same rules as the single-invoice delete).
  - **Clear publishing data** — resets "exported to QuickBooks" on the
    selected invoices: `qbo_sync_status/bill_id/synced_at/error` cleared,
    approved ones go back to **QBO Ready** for a re-sync. Flow-side only —
    the Bill already in QBO is NOT touched (re-syncing creates a second
    bill there; void the original in QBO first if it shouldn't stay).
  - **Export PDFs (one file)** — downloads every selected invoice's
    documents merged into a single PDF (`/api/invoices/batch-export?ids=…`).
  - **Send by email** — an inline form (recipient + optional note) emails
    the merged PDF via Resend (admin only).
- **Detail pane**: amount/status header, a possible-duplicate warning if
  relevant (pinned together at the top of the list when present — see
  below), an approval stepper (green = decided, blue = current step, grey
  = upcoming — reflecting **all** of a step's required approvers under the
  conditional routing model, not just one), the
  Approve/Reject/Hold/Cancel/Review-Complete buttons for whichever apply,
  [admin overrides](#admin-overrides), and admin-only permanent invoice
  deletion.

**Bill panel** ([`src/components/BillPanel.tsx`](src/components/BillPanel.tsx)):
redesigned to read like an actual invoice document rather than a form —
every field uses a "ghost" style (invisible border at rest, a line appears
on hover/focus) instead of a boxed input, still fully editable in place:
vendor/email, bill date/due date/bill number, total/tax/currency (Subtotal
computed — see [Field extraction](#field-extraction-openrouter-model-agnostic)
for how totals are derived), and a **Category-details table** (Category,
Description, **Project/customer**, Tax %, Class, Amount, Linked) with
add/delete rows. On sync this maps directly to the QBO bill — header
fields to the bill, rows to line items. The panel also now holds the
**Discussion** thread (@mention teammates — see below — with a real-time
unread badge) and the **Audit trail** (a chronological, human-readable
timeline of everything that happened on the invoice, built from
`audit_log` + comments by
[`src/lib/audit-timeline.ts`](src/lib/audit-timeline.ts), shared by the
in-app view and the downloadable PDF so the two never drift apart) — moved
in from the side panel, and a redundant "Document details" panel (fields
that just duplicated the audit trail) was removed.

**@mention notifications** (migration 0026): typing `@name` in the
Discussion composer ([`src/components/MentionComposer.tsx`](src/components/MentionComposer.tsx))
resolves to real org members and records `mentioned_user_ids` on the
comment server-side (not parsed from free text). Each mention creates a
`notifications` row (inbox at `/notifications`) and, if `RESEND_API_KEY`
is configured, a best-effort email
([`src/lib/notify.ts`](src/lib/notify.ts)) — a missing key or failed send
never blocks posting the comment itself.

**Possible-duplicate detection** pins matched invoices together at the top
of the list pane (not just an inline banner) when opening one — see
[Document search](#document-search).

**Multi-document support**: an invoice can carry the primary file plus any
number of additional pages (`invoice_documents`). The document viewer gets
a page switcher ("2 / 3") and an **"Add document"** button. On sync,
**everything** attaches to the bill: the audit-trail PDF + all documents
([`src/lib/qbo-attachments.ts`](src/lib/qbo-attachments.ts)).

`/invoices/[id]` still exists as a redirect to `/dashboard/[id]`, in case
anything links to the old URL shape.

---

## Billing & usage

`/billing` — Flow's own usage billing: how many documents each client org
has processed, at the org's per-document rate in USD (default **$0.15**,
editable by admins).

- One `usage_events` row per document accepted into the pipeline: an
  inbound-email attachment (after the signature-image filter) or a manual
  upload. Recorded at **acceptance**, never at retry time, so a document
  that fails and gets re-queued still counts exactly once (migration 0061).
- The Billing page shows the total documents processed, the suggested
  charge (count × rate), a by-month rollup, and the recent documents list.
  Any org member can view; only admins can change the rate.
- The rate editor greys the **Save** button until the value actually
  changes, then reads e.g. **"0.15 saved"** with the **saved-on date**
  (`organizations.usage_rate_updated_at`, migration 0062).
- **Stripe Checkout** ("Pay now") charges the suggested amount via Stripe's
  hosted page (amount = documents × rate, USD). Requires `STRIPE_SECRET_KEY`;
  without it the page shows "Stripe is not configured". Success/cancel
  redirect back to `/billing?payment=success|cancelled`.
  `NEXT_PUBLIC_APP_URL` sets the redirect base (defaults to VERCEL_URL).

## Settings

`/settings` (member management is admin-only; everyone can edit their own
name/photo):
- **My profile** — display name, photo upload (`avatars` bucket, 0016).
- **Members** — a real table (avatar, name, email, role, status, 2FA —
  genuinely read from Supabase's enrolled-factors data, not a placeholder),
  search, and an **Add new users** modal (creates the `auth.users` account
  if needed, sets an initial name). Role changes and removal are inline.
- **Projects / customers** — create/edit/deactivate. No longer linked to a
  workflow here — since migration 0027, which project(s) an approver
  covers is expressed as a Customer condition on that approver, configured
  on [`/workflows`](#workflow-routing--rules) itself, not on the project
  record.

---

## Reports

`/reports` ([`src/lib/reports.ts`](src/lib/reports.ts)): pick a metric
(count/amount/tax), an optional group-by (month/vendor/status/project), and
filters (status, vendor contains, project, amount range, date range) — runs
against whatever invoices RLS already lets the caller see, so an admin sees
org-wide totals and a `user` sees their own scope. Configs can be saved
(`saved_reports`) for reuse.

**Known gap**: the project filter/grouping still reads the invoice-level
`project_id` only, not the per-line-item projects from migration 0019 — so
it under-reports invoices whose lines split across multiple projects. Not
yet rebuilt against line items.

---

## Deploying

1. Push this repo to GitHub, import it in Vercel.
2. Add the same env vars from `.env.local` in Vercel's Project Settings → Environment Variables (production values — a separate Supabase project from your local/dev one is strongly recommended).
3. Point the Resend Receiving webhook URL at your production domain.
4. Update `INBOUND_EMAIL_DOMAIN` to match whatever subdomain's MX you actually configure for production.

---

## What's not built yet

This is groundwork, not a finished product. In priority-ish order:

- **Org signup/invite flow for the very first admin** — once one admin
  exists, [Settings](#settings) can invite everyone else; bootstrapping
  that first admin is still a manual SQL insert (see [First org
  setup](#first-org-setup)).
- **Real Supplier entity** — supplier defaults, duplicate detection, and
  the Document Search Supplier filter all match on normalized vendor-name
  text rather than a proper linked entity. Works, but fragile if the same
  supplier's name comes through spelled differently across invoices.
- **Reports vs. per-line-item projects** — see the gap noted in
  [Reports](#reports).
- **Real-time chat** — @mention notifications exist (migration 0026), but
  the comment thread itself is still a simple list: no live updates
  (Supabase Realtime — posting a comment doesn't push to other open tabs,
  it needs a refresh) and no typing indicators.
- **Visual polish** — functional Tailwind, not a designed product, outside
  the Bill panel's document-style pass.
- **Rejection detail** — a rejected invoice records the decision but
  there's no UI prompt to capture *why* at reject time.
- **Auto-sync on approval** — bills reach QBO Ready automatically; the
  final push to QBO is still a manual admin button per bill (no queue /
  scheduled auto-sync yet). This is also a deliberate hard rule, not just a
  gap: nothing reaches QBO until an admin presses the final button.
- **Async extraction** — uploads/emails still wait inline on the 20–60s
  OpenRouter call; moving that to a background queue is the planned "item
  #1" (see the [session log](#session-log--2026-08-24-handoff-notes)).

---

## QuickBooks Online sync

### The two hard rules

1. **Flow never writes to QuickBooks except the final approved bill.**
   Suppliers, taxes, classes, projects, and categories are all **read-only
   mirrors** — Flow pulls them and matches against them; it never creates or
   updates them in QBO.
2. **No bill reaches QBO until the full approval workflow is done AND an
   admin presses the final button.** The status flow is:
   `on_review → on_approval → qbo_ready → approved (synced)`.

### Read-only mirrors (Settings → Data from QuickBooks)

Each has a "Sync" button; **Refresh data** pulls everything at once:

| Mirror | What it is | Notes |
|---|---|---|
| Tax | Codes with resolved rates (H → 13%, M&E (ON) → 13%, Out of Scope → 0%) | Only active codes with usable rates appear, exactly like Dext/ApprovalMax. The bill's Tax field offers these — type "h" → H (13%). |
| Classes | QBO class list | Feeds the workflow matrix cells + bill Class field |
| Categories | QBO Chart of Accounts, account numbers starting 2/5/6 | Display as "5-15450 - HVAC" (number + name); the bill Category field searches this |
| Suppliers | Full QBO vendor list (paginated — PostgREST caps at 1000/request) | OCR vendor names are matched EXACTLY (normalized) against this list |
| Projects | QBO customers with `IsProject=true` | Regular customers are NOT imported; 450+ projects |

### Vendor matching (exact only)

At ingestion, the OCR'd vendor name is matched **exactly** (case- and
punctuation-insensitive) against the QBO supplier mirror. An exact match
stores the canonical QBO name; **no match keeps the OCR name but flags the
invoice** (`qbo_vendor_matched=false`) with a visible warning — and sync is
refused until a human picks the correct supplier. Flow never creates
suppliers, and never fuzzy-matches (a near-miss is a mismatch, not a guess).

### CO/Extras — removed 2026-08-27

There used to be a "Does this invoice have COs or Extras?" checkbox
(approvers only) that, once ticked, required a note before approving and
auto-stamped every unclassed line item as QBO class "Extras". **It never
actually worked**: the auto-stamp filter (`.not("class", "in", '("Contract",
"Change Orders")')`) can never match a line whose class is NULL under SQL
three-valued logic — the normal starting state for every line — so it
silently fired for nobody in the typical case. Removed entirely (code,
`invoices.has_cos_or_extras` column via migration 0065, the required-note
rule, the checkbox) rather than fixed, since the per-line CON/CO tags below
already cover this need correctly and make an invoice-level flag redundant.
**Do not re-add an invoice-level CO/Extras flag or auto-stamp rule** — if a
line needs distinguishing from contract value, tag it CON/CO directly.

### Per-line Contract / Change Order tags (CON / CO)

Every line item in the Bill panel has a **CON / CO toggle** next to the
class search box:

- **CON** writes the QBO class **"Contract"** — the line is original
  contract value.
- **CO** writes the QBO class **"Change Orders"** — the line is extra work
  beyond the contract.
- The search box still sets any other class (Extras, HB, Chargeback, …).

The toggle writes the line's `class`, which syncs to QBO as that line's
`ClassRef` — so the construction fold app can read each line's class back
out of QBO and tell contract value from change orders (e.g. one line
$50,000 = CON, the next $10,000 = CO, both electrical). Class is a human
decision: it **never** comes from the document, and re-extraction preserves
it (like project) instead of reverting it. If a supplier-default rule sets
a class, it applies to lines with no class yet.

The two class names are the exact QBO class names Fluid already has
(`Contract`, `Change Orders`); the constants live at the top of
`BillPanel.tsx` (`CON_CLASS_NAME` / `CO_CLASS_NAME`) if a client ever uses
different names.

### The final sync

When a bill completes every workflow step it lands in **QBO Ready** (a
dashboard tab, admin-only). The admin opens it and presses **"Sync to
QuickBooks (final)"** — the only path to QBO. The bill is created with:

- the **matched supplier** (resolved QBO vendor id — never created),
- line items with **numbered categories** (resolved by account number),
- tax, due date, and the **accounting-instructions thread as the bill memo
  (PrivateNote)**,
- **attachments**: the audit-trail PDF and every invoice document.

On success the status becomes `approved` and the bill links straight to QBO.
Errors are recorded on the invoice (`qbo_sync_status='error'` + message).

### Connection & auth

Requires an Intuit Developer app: create one at developer.intuit.com,
register `QBO_REDIRECT_URI` in its Redirect URIs (exact match — and make
sure it's in the **Production** tab's list, not just Development), and set
the three `QBO_*` env vars. OAuth uses `com.intuit.quickbooks.accounting`;
tokens are stored per-org in `qbo_connections` (RLS: admins only) and
refresh automatically. The Settings page has Reconnect / Disconnect.

## Product direction

Approval Flow is being built as a **multi-tenant SaaS for multiple paying
customers** — one Supabase project, many orgs, isolated by RLS. The
end-to-end vision:

1. Invoices and receipts come in however the customer likes (upload, email,
   later: mobile photo capture).
2. Field extraction pulls vendor/amount/due date/line items; saved supplier
   rules override it where a human has already told the system what's
   authoritative.
3. A rules-based routing engine pushes the invoice through the right
   approval workflow for its amount/vendor/project/line items.
4. Authorized people **chat about the invoice** in a full chat window —
   the discussion thread here is the foundation for it.
5. On approval, the invoice syncs to the customer's accounting system
   (Xero / QuickBooks) as a bill with **every attached file**: the
   **audit-trail PDF** (chat history + approval audit trail) plus **all
   invoice documents** (primary + any added pages)
   ([`src/lib/qbo-attachments.ts`](src/lib/qbo-attachments.ts)).

A production domain/brand is coming; `INBOUND_EMAIL_DOMAIN` and the org
inbound addresses already flow from env vars, so rebranding is config, not
code.

---

## Known limitations worth knowing about

- **No automated tests.** Everything so far has been verified by hand
  (manual upload, email webhook via curl, full approve/reject/hold/cancel
  flow, admin overrides, supplier rules) in a live Supabase project.
- **Single-user workflows in practice**: with few org members, "requires my
  approval" and "created by me" will often show the same invoices — the
  filters are correct, there just isn't more than one person to exercise
  them against yet.
- **`@anthropic-ai/sdk` was removed** from `package.json` — extraction is
  entirely OpenRouter-based now (raw `fetch`, no SDK dependency).

---

*Authored by Araza.*
