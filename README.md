# Flow by UFIRST

Invoice approval workflows (ApprovalMax-style), built on Next.js, deployed on
Vercel, with Supabase for Postgres, Auth, and Storage, and an OpenRouter
model for invoice field extraction.

Status: **early-stage groundwork**, not a finished product. Auth
(including self-serve signup with a 14-day trial, and per-user TOTP
two-factor), invoice ingestion (manual + email, with multi-invoice split
detection), a workflow-selection routing engine, ApprovalMax-style
conditional per-step approval routing (multiple approvers per step, each
eligible only when an invoice's Class/Category/Supplier/Customer matches
their own conditions), role-scoped visibility, a review queue,
per-supplier default rules, @mention notifications, QuickBooks Online
sync, Statement Reconciliation, plan-based billing, and a master-detail
dashboard UI are all working end to end. See [What's not built
yet](#whats-not-built-yet) for the real gaps.

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

Full schema: [`supabase/migrations/`](supabase/migrations/) — numbered
through `0091` as of 2026-08-30 (a few numbers were added then reverted for
a shipped-then-reverted feature, e.g. 0043/0044, 0087/0088→0089 — see the
table below and each session log for why). [`supabase/full_schema.sql`](supabase/full_schema.sql)
is every migration concatenated in order into one file — the fast path for
a fresh Supabase project (see [Local development](#local-development))
instead of pasting 89 files one at a time; it's kept in sync by hand
whenever a new migration lands, so treat the individual files under
`migrations/` as the source of truth if the two ever disagree. See
[Migration history](#migration-history) for what `0001`–`0056` added in
detail; everything after that is documented inline in its own section
(linked from the table's closing note) rather than re-listed row by row.

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

**0057 onward** (`0057`–`0091`) aren't re-listed row by row here — each is
documented in the session log or feature section it belongs to: QBO
payment status (0079), deadlines/reminders (0073), the ops dashboard
(0077), self-serve signup + trial (0085/0086, [session log —
2026-08-29 to 2026-08-30](#session-log--2026-08-29-to-2026-08-30)), Statement
Reconciliation (0081–0084), the plan-derived extraction mode saga
(0088 added a column, 0089 dropped it again — same session log), MFA
recovery codes (0090, [Two-factor authentication
(TOTP)](#two-factor-authentication-totp)), real-time Discussion
updates (0091, same session log), and the real Supplier entity (0092,
[Session log — 2026-08-30](#session-log--2026-08-30-supplier-entity--admin-mfa-reset)).
Check `supabase/migrations/` directly for the exhaustive list.

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

### Small polish pass: list styling, Amount formatting, invoice list

Three quick, independent fixes right after the audit:

- **Collapsed Invoices strip didn't match the Documents strip** — two
  collapsed panes side by side (`CollapsiblePane.tsx` for Invoices,
  `DetailSplit.tsx` for Documents) used completely different styling: no
  fixed width vs. `w-10`, plain ghost button vs. a bordered/shadowed white
  button, light vs. bold label. `CollapsiblePane.tsx`'s collapsed markup
  now copies Documents' classes exactly — it's the only place that
  component is used, so no risk to another caller.
- **Amount didn't reformat until the save round-trip landed** — typing
  `5800` and tabbing away left the raw text on screen (no comma, no
  decimals) until the server confirmed the save and sent back the
  `num2`-formatted value. The Amount field's `onBlur` (`BillPanel.tsx`)
  now reformats immediately with `toLocaleString` (comma thousands + 2
  decimals) for both a plain typed number and an evaluated formula
  result, instead of waiting on the network.
- **Invoice number now shows under the Amount in the Invoices list**
  (`InvoiceSelectionList.tsx`) — a quick eyeball check against the source
  document while scanning the list. New `invoiceNumber` field on
  `SelectableInvoice`, wired from `inv.invoice_number` in the dashboard
  page's `selectableRows` mapping.

### Prev/Next invoice navigation; document viewer stays open across it

New chevron buttons in the top bar, next to Queue — flip through invoices
in the exact order (and under the same filters/search) the Invoices list
is currently showing, disabled at either end. `deleteInvoiceAction` now
takes a `nextInvoiceId` (computed the same way, previous one as fallback)
and the current `qs`, redirecting there instead of hard-redirecting to
bare `/dashboard` — so deleting stays in this view and lands on the next
invoice instead of jumping to the newest invoice overall.

Getting the document viewer's open/closed state to survive this was the
real work: `DetailSplit`'s `showDoc` was a plain `useState`, relying on
the component instance never remounting across invoice navigation (a
pre-existing comment even says so). That was fine for the invoice LIST's
own links (which HIDE while a document is focused, so you could never
actually click a different invoice through them while one was open) —
but Prev/Next, sitting in the always-visible top bar, is a genuinely new
way to switch invoices while a document stays open, and relying on
implicit React state preservation wasn't holding up in practice. Made it
explicit instead: a `doc=1` query param now travels with the invoice id
everywhere `qs` is used (Prev/Next, the list, delete's redirect).
`openDocument`/`hideDocument` write it via `router.replace(...,
{ scroll: false })`; a `useEffect` scoped to `invoiceId` changing (never
firing on the user's own click on the CURRENT invoice) resyncs local
`showDoc`/`focused` from it whenever the invoice actually changes.
**Do not go back to deriving "document open" purely from local state** —
key it through the URL like this if it needs to survive navigation.

### Email ingestion made durable against partial failure (migration 0066)

The user reported the same emailed file getting processed multiple times,
creating duplicate invoices. **Not a dedup bug** — the "possible duplicate"
detection (supplier + invoice number match) is intentional and stays
exactly as-is; a genuine amendment/resend needs to go through that review,
not be silently blocked. The real problem was durability:

An attachment only ever got a durable `ingest_jobs` row if it overflowed
the webhook's inline time budget or errored — anything processed inline
within budget had **no record backing it at all**. Extraction alone can
take 20–60s per document; with several attachments, Vercel's hard 60s
function cap could kill the webhook mid-attachment. Whatever had already
become an invoice stayed (no way to undo it, nor should there be); the
rest were silently lost with zero trace; the only recovery offered was
"please re-forward the email" — which reprocessed the WHOLE email,
including the attachments that had already succeeded, creating the
duplicates.

**Fix**: every attachment becomes its own `ingest_jobs` row immediately,
before any extraction starts — not just the overflow ones. The webhook
then works through them via `runNextIngestJob` (`src/lib/ingest-queue.ts`)
— the SAME claim-and-process logic the background poller already uses, so
there's one code path instead of two that could drift apart. A hard kill
mid-way now only ever risks the ONE job actively in flight; everything
else already sits safely `queued` for the poller (or this same webhook's
own loop, next time) to finish.

Three supporting pieces, all in `ingest-queue.ts`:
- **`resetStaleIngestJobs`** — a job stuck in `status='processing'` (the
  function that claimed it died) now recovers back to `queued` for a
  natural retry, or fails terminally after 3 attempts. Previously stuck
  forever — `runNextIngestJob` only ever looks for `status='queued'`.
- **`otherActiveJobsExist`** — an email with several attachments (several
  jobs sharing one `inbound_email_log` row) no longer flips to "not
  processing" the moment the FIRST job finishes while siblings are still
  in flight. Checked before EVERY completion path (success, retry,
  terminal failure, no-invoice-data) clears `processing`.
- **`ingest_jobs.force_split`** (migration 0066) — the `[1N]`/`[NM]`
  subject-code "force split review" decision is now persisted on the job
  itself. It used to only survive for attachments processed inline —
  routing every attachment through the queue would otherwise have
  silently dropped it.

**Known, accepted tradeoff**: on Vercel's Hobby plan, cron jobs only run
once a day, so genuinely browser-independent processing isn't available
without a plan upgrade — anything that doesn't finish within one webhook
invocation still waits for the poller (which needs a dashboard open) or
the next inbound email for that org to trigger another pass. Durability
(nothing is ever lost or silently duplicated) is solved; zero-latency
processing with no browser open at all is not, and would need Vercel Pro
(or a similar scheduled-job service) to close.

### Email ingestion made idempotent against retried webhook deliveries (migration 0070)

The 0066 durability fix above didn't fully close the "same invoice
duplicates" incident — it recurred, live, for the same supplier's
invoices. Root cause was one layer deeper: the webhook does real work
synchronously (list/download attachments, then run the ingest queue for
up to 35s) before ever returning a response. If Resend doesn't get a fast
reply, it retries delivery of the SAME `email.received` event — and the
handler had no way to tell "I've already seen this exact delivery" from
"this is a brand new email." A retry created a second
`inbound_email_log` row and a second set of `ingest_jobs` for the
identical attachments, producing duplicate invoices.

**This is explicitly NOT the "possible duplicate" business case** (a
genuine resubmission/amendment that must go through review — the
long-standing rule against ever adding silent duplicate-skipping logic
for that case still stands, untouched). It's the literal same event
notification arriving twice, which should never be processed twice at
all — an infrastructure idempotency question, not a business judgment
call.

**Fix**: `inbound_email_log.email_id` (Resend's own id for the email) is
now checked FIRST, before any slow work — a retry returns almost
instantly instead of redoing 30+ seconds of work, and (best-effort) just
nudges the existing job queue forward once more in case the first attempt
got cut off mid-processing. The later `inbound_email_log` insert also
carries `email_id` under a unique index, so a genuinely concurrent
delivery (not just a sequential retry) hits a constraint violation and
bails out the same way, instead of silently creating a second row anyway.

### Multi-tenant onboarding tool: `/admin/organizations`

The app was already multi-tenant-ready in every load-bearing way — RLS
scopes every table by `organization_id`, the inbound invoice address is
already per-org (`inbound_email_token`/`inbound_email_local`, see
[Email ingestion](#email-ingestion-resend-receiving)), QBO connections are
per-org, and `inviteMember` (Settings) already invites arbitrary emails
into an *existing* org. The one real gap, hit when onboarding a second
paying tenant ("Fluid"): there was no way to create a NEW org at all short
of hand-inserting rows in the Supabase SQL editor.

**Fix**: `src/lib/platform-admin.ts` adds a cross-org "platform admin" check
(`PLATFORM_ADMIN_EMAILS`, a comma-separated env var — deliberately NOT a DB
role, since this is about who can create tenants, not who administers one).
`src/lib/admin-actions.ts`'s `createOrganizationAction`, exposed at
`/admin/organizations` (linked from the sidebar only for platform admins),
does the full bootstrap in one step:
1. Inserts the `organizations` row (auto-generates a slug from the name,
   retrying with a random suffix on collision; `inbound_email_token` is a
   DB default, `inbound_email_local` is optional at creation time — the
   org's own admin can set/change it later from Settings either way).
2. Creates (or reuses) the first admin's Supabase Auth account by email —
   same `createUser`-then-`listUsers`-fallback approach as `inviteMember`.
   They sign in via `/login`'s one-time link; no password to hand over.
3. Adds them to `organization_members` with `role: 'admin'`.
4. **Bootstraps a default workflow** — one `approval_workflows` row
   (`is_default: true`), one step, with the new admin as that step's
   `is_default` approver. Skipping this was tried and caught before
   shipping: `decide()` and friends in `dashboard-actions.ts` silently
   no-op when `invoice.workflow_id` is null, so a org created without a
   workflow would accept invoices forever without Approve/Reject ever
   doing anything.

This intentionally mirrors the *admin-provisioned* model (you set up the
tenant and hand its first user an email + address), not public self-serve
signup — there's no plan selection, billing capture, or email verification
flow, since it's used to onboard specific named clients, not open
registration.

**Platform-admin support access + org switcher**: the owner needs to be
able to see into any client's org to actually support them — check what
they've shared, debug a stuck invoice, etc. — not just have created the
tenant once. `createOrganizationAction` now also adds the calling platform
admin as an `organization_members` row (`role: 'admin'`) on every org they
create, alongside that org's own first admin; `joinOrganizationAction` is
the same for orgs that predate this (or if you were ever removed) — a
"Join as support"/"View" button per row on `/admin/organizations`. Because
`is_org_admin(...)` is unconditional in every RLS policy (invoices,
comments, documents, line items all route through `can_see_invoice()`,
which checks `is_org_admin` first), this is genuine full visibility, not a
read-only mirror.

Having more than one `organization_members` row breaks `current-org.ts`'s
old MVP assumption ("a user belongs to one org, so just take their first
membership") — fixed by reading an `active_org_id` cookie first
(`switchOrgAction` sets it, re-verifying membership server-side rather than
trusting the submitted id) and only falling back to "first membership" when
it's unset or stale. A regular single-org user never sets this cookie, so
their behavior is unchanged. The dashboard sidebar only renders the
`OrgSwitcher` dropdown when a user actually has more than one membership
row — in practice, just the platform admin — so nobody else ever sees it.

**Deferred, on purpose**: the shared inbound-email domain still reads as
`flow.ufirst.co` in code comments/`.env.local` — fine for now since the
app itself isn't finalized yet; revisit before a client outside Ufirst
actually forwards invoices there, so their capture address doesn't
visibly reference a different company's domain.

### Fix: searching while an invoice is open could 404 the whole page

Reported live: open an invoice, type anything in the top search box that
doesn't match that invoice's vendor/file name/invoice number, and the page
hard-404'd (`flow.ufirst.co/dashboard/<id>` → "This page could not be
found").

Cause: `selected` (the currently-open invoice) was looked up from
`filtered` — the SAME array already narrowed by the view tab, the quick
search, and the advanced "Document search" filters, for the sidebar list.
The moment the open invoice no longer matched whatever was typed, it
dropped out of `filtered`, `selected` came back `undefined`, and
`if (selectedId && !selected) notFound()` fired for real.

Fix ([page.tsx](src/app/dashboard/[[...id]]/page.tsx)): `selected` is now
looked up from the full, unfiltered `invoices` list (still RLS-scoped to
the org) instead of `filtered`. The sidebar keeps narrowing exactly as
before; the invoice you have open no longer disappears — and 404s — just
because it doesn't match the current search/filter/view. A genuine 404
(wrong org, id never existed, RLS-hidden) still fires correctly, since
`invoices` only ever contains what RLS actually returns for that user.

### A third per-line class toggle: E for Extras

CON/CO already toggled a line's class to "Contract"/"Change Orders";
"Extras" was the same real QBO class but had no shortcut button, only the
free-text class search box. Added an **E** button next to CON/CO writing
class `"Extras"` — same per-line mechanism as CON/CO, not a revival of the
removed invoice-level CO/Extras flag (see that section above — the rule
against re-adding it still stands). Widened the Class column (118px →
176px) to fit the third button and stop the committed class value
truncating to "Chang…" instead of showing "Change Orders" once idle.
Restyled per direct feedback shortly after shipping: all three buttons
are blue by default (was three different colors per button when
unselected/selected), turning yellow specifically when selected, instead
of each button carrying its own distinct selected-color.

### Real per-role permissions for the plain "user" role

Previously `role = 'user'` had exactly the same bill-editing rights as
admin — `canEdit` was just `!isAuditor`, with no actual role check — and
could see Workflows, Billing, and all of Settings. None of that was
gated by role at all, just by auditor status. Prompted by preparing to
onboard a second, real, non-Ufirst tenant where "user" needs to mean
something.

**Bill panel**, for `role="user"`:
- Category, description, project, tax, amount, bill header fields,
  add/delete/clone lines, document upload, re-extract, and reorder pages
  are locked unconditionally — `canEdit` in
  [page.tsx](src/app/dashboard/[[...id]]/page.tsx) is now admin-only.
- Class (CON/CO/E) and the accounting note stay editable, but ONLY until
  the signed-in user approves the invoice themselves — checked against
  `invoice_approvals` directly (not invoice status), so it holds
  regardless of where the invoice moves afterward — see `classReadOnly`/
  `instructions.readOnly` and `lockedForPlainUser`.
- Discussion/comments stay open always (`canComment`), even after the
  above lock — auditors remain the only role that never gets to comment.

**Data-loss bug found and fixed while wiring this up**: `saveLineItem` did
a blind `update(values)` built from `formData.get()` for every field. A
disabled `<input>`/`<textarea>` (now reachable whenever a role can submit
the class toggle but not the rest of the row) is dropped from `FormData`
by the browser entirely — so description/amount/`linked` would have been
silently nulled/unchecked on every class-only save. Fixed with a partial
patch that only includes fields actually present in the submission; a
`linked_editable` marker input covers the one genuinely ambiguous case (a
checkbox looks identical in FormData whether it was disabled-and-omitted
or enabled-and-unchecked).

**Reject now requires a reason.** It used to be a bare one-click button
capturing nothing. `RejectReasonModal` forces a non-empty reason in a
popup; `rejectWithReason` (dashboard-actions.ts) posts it to the invoice's
**Discussion** thread as `"Rejected: …"`, not the accounting-notes thread
(which stays reserved for notes to accounting) — then reuses `decide()`'s
existing eligibility/step/audit logic untouched, with an empty `FormData`
so nothing also lands in `accounting_instructions`.

**Rejection now actually emails the submitter (migration 0072).**
Previously nothing did — the Discussion comment above was the only
record, and the submitter would only see it if they happened to reopen
the invoice. `sendRejectedEmail` (`notify.ts`) sends them the reason, and
sets a real `X-MS-Categories: Rejected` header on the outgoing message —
copied directly from inspecting ApprovalMax's own rejection emails, which
set the same header so Outlook auto-tags the message with a colored
"Rejected" category. Other mail clients just ignore the header. A new
`notifications.type = 'rejected'` row also lands in-app. `notify.ts` was
refactored around this — `sendEmail` is now the one shared Resend POST
(previously duplicated three ways) that every send function calls,
`headers` being the only thing `sendRejectedEmail` needs beyond what the
others already had.

**Page access**, for `role="user"`: full redirect away from `/workflows`
and `/billing`; `/settings` shows only "My profile" (`showOrgSettings`
gate in settings/page.tsx) — Integrations/Billing/Members/Projects are
admin-and-auditor territory. Sidebar nav links hidden to match.

**Invoice visibility restricted to submitted/assigned-project invoices**
(migration 0067): a plain user previously saw every invoice in the org via
a `project_id is null` blanket-visibility clause in `can_see_invoice()`
and the `invoices` RLS policies — dropped, so now they only see invoices
they submitted themselves or are an eligible approver for (checked via
`is_eligible_approver()`, ANY step of the workflow — reuses the existing
Class/Customer/Supplier/Category step-approver conditions rather than
building a second, separate "assignment" concept). Admins/auditors are
unaffected. **Caveat found while writing the migration**: the dashboard's
own invoice list (`getCachedInvoiceList` in org-cache.ts) fetches via the
*admin client* for org-wide caching — RLS is per-user and can't be shared
across a cache key like that — so the RLS policy change alone never
touches what actually renders in the sidebar. Added
`isEligibleApproverForInvoice`/`visibleInvoices` in
[page.tsx](src/app/dashboard/[[...id]]/page.tsx) as a JS-side mirror of
the exact same rule, applied to the list, the view-tab counts, and the
invoice-detail lookup. Reports and other RLS-bound queries didn't need
this — they go through the regular client and are already covered by the
migration alone.

**Two admin-workflow bugs surfaced while testing the above**, both in
`overrideStatus`/reassignment (dashboard-actions.ts):
- Overriding status back to `on_approval` (e.g. undoing a rejection after
  talking to the submitter) left the OLD rejected `invoice_approvals` row
  and stale `current_step_order` in place — `decide()`'s `alreadyDecided`
  check then treated the approver as having already voted (rejected,
  again), and the stepper kept showing red. Only resetting on `on_review`
  missed the far more common "just reopen it" path. Now resets
  `current_step_order` to 1 and clears `invoice_approvals` for
  `on_approval` too, unless coming from `on_hold` (that's resuming the
  same in-progress step, not restarting — and holding never records a
  decision to clear anyway).
- New `setInvoiceStage` + a "Stage" dropdown in the Bill panel's Admin row
  (only shown for multi-step workflows) lets an admin send an invoice
  straight to a **specific** stage regardless of current status —
  "reassign at any stage, and that's where it starts from." Clears
  `invoice_approvals` for that step and any AFTER it, but leaves EARLIER
  steps' genuine decisions on the record.

**Audit trail now sorts newest-first** for everyone — was oldest-first, so
seeing "what just happened" meant scrolling to the bottom. Lines
mentioning **"reject"** now render bold and red, and lines mentioning
whole-word **"approved"** render bold and green (not a bare `/approve/`,
so "Reassigned to a different **approver**" doesn't false-positive as
green) — applied per-line (the decision's own summary vs. a
reject-reason comment's detail line), not the whole entry.

### The `overrideStatus`/`setInvoiceStage` fixes above didn't actually work — found live

Tested live right after shipping: forcing a rejected invoice back to
`on_approval` still showed the old rejected decision (a red X on the
stepper) and the PM it was reassigned to didn't see it under "Requires my
approval." Root cause was one step deeper than the two bugs above —
`invoice_approvals` **never had a DELETE policy at all**, only
read/insert. So every `invoice_approvals.delete()` call in
`backToReview`/`overrideStatus`/`setInvoiceStage` was silently deleting
**zero rows** through the RLS-bound client — Postgres/PostgREST don't
treat "no policy matched" as an error, so nothing surfaced until someone
actually looked at the result. Migration 0068 adds `"invoice_approvals:
admins can delete"` (mirrors `invoices`' own existing `"admins can
delete"` policy), and the three call sites also now route the delete
through the admin client directly as defense in depth, since `canReview()`
already confirmed the caller.

### Matrix workflows: a stage nobody matches gets skipped, not stuck

Reported live on a real 3-stage matrix workflow (PM Approval → CO Team
Approval → Accounting): a PM sometimes hands an invoice straight to the
CO team, skipping PM Approval for that one invoice entirely. Since
nobody's condition matched step 1 for it, the invoice got stuck with "No
approver currently matches this invoice at step 1 ... It can't be
approved as-is," needing a manual admin Reassign every time. A matrix
workflow's steps were never meant to all apply to every invoice — an
unmatched step (no conditional approver's rules apply, no default
approver) just isn't one of that invoice's stages. New
`firstMatchingStepFrom` (dashboard-actions.ts) finds the first step from
a given point onward that actually has a matching approver;
`reviewComplete` (entering the workflow) and `decide()` (advancing after
each approval, including its self-heal branch) both use it now instead of
blindly landing on step 1 / step+1. Falls back to the original step only
when nothing from there through the last step matches, so a genuinely
unconfigured workflow still surfaces the existing warning.

### Document split is 60/40 (bill/document), not an even 50/50

The bill is what's actually being worked on; the document is reference
material next to it. `DetailSplit`'s auto-sizing on opening a document
now gives the bill 60% of the available width (still floored at 600px on
a smaller screen, still adjustable afterward via the drag handle) instead
of an even half.

**Fix: the split reset after deleting an invoice (or Prev/Next) while a
document was open.** The width-recompute effect was only keyed on
`showDoc` — but deleting redirects to the next invoice with the SAME
`doc=1` state carried over, so `showDoc` never flips false→true (it was
already true) and the effect never re-fired for the new invoice; same gap
would hit Prev/Next while a document is open. Now also keyed on
`invoiceId`, so the 60/40 split re-asserts on every invoice change, not
just the transition into first opening a document.

### Middleware hardened against a slow Supabase Auth call taking the whole site down

Live incident: `middleware.ts`'s `supabase.auth.getUser()` call had no
timeout, and it runs on **every request across the entire app** (see its
`matcher`). A slow/unresponsive moment from Supabase turned into a full
site `504 MIDDLEWARE_INVOCATION_TIMEOUT` for every visitor, in every
browser — including incognito, since this happens server-side before any
HTML is even returned, so clearing local cache/cookies can't fix it.
`getUser()`'s return value isn't even used in this file — its only job is
the side-effect cookie refresh via the `setAll` callback — so it's now
raced against a 5-second timeout and the request proceeds regardless of
which one wins. Worst case on a genuinely slow Supabase moment: one
request sees a slightly stale session (self-corrects on the next one)
instead of the whole app going down.

---

## Session log — 2026-08-29 to 2026-08-30

Another long session (user + AI pair). Full detail on each substantial
piece lives in its own section (linked below) rather than repeated here —
this is the connecting narrative plus the smaller fixes that didn't earn
a dedicated section of their own.

- **Statement Reconciliation matching bug** — fixed, plus a "Reconcile
  again" button and open-in-new-tab links. See [Statement
  Reconciliation](#statement-reconciliation-migrations-0081-0084).
- **Self-serve signup + 14-day trial**, shared `bootstrapOrganization()`
  helper, soft-lock on trial expiry, platform-admin trial extension. See
  [Billing & usage](#billing--usage) and
  [Authentication](#authentication).
- **Terms & Privacy pages** (`/terms`, `/privacy`) — public, branded,
  drafted with real content specific to Flow's actual product/plans/trial
  and sub-processors (Supabase, OpenRouter, Resend, Stripe, QuickBooks
  Online), structurally informed by researching ApprovalMax's own public
  terms/policy pages but not copied from them. Company/jurisdiction
  details: UFIRST LLC, Wyoming, USA; support contact `support@ufirst.co`.
  **Not reviewed by counsel** — flagging that explicitly since these are
  live, linked-from-signup pages.
- **Per-user self-service MFA (TOTP)**. See [Two-factor authentication
  (TOTP)](#two-factor-authentication-totp).
- **Plan-derived Simple vs Complex extraction mode**, plus the manual
  "Convert to one line" action. See [Simple vs Complex extraction
  mode](#simple-vs-complex-extraction-mode).
- **Starter and Growth's included-document counts raised** (50→100,
  150→200; prices unchanged) — see [Billing & usage](#billing--usage).
- **Ingest queue no longer flashes "Failed" during a retryable attempt.**
  `fail()` in [`src/lib/ingest-queue.ts`](src/lib/ingest-queue.ts) used to
  mark `upload_log`/`inbound_email_log` as errored on **every** failed
  attempt, even ones that go on to succeed on the next automatic retry
  (found live: a real invoice's ingest job failed once, auto-retried, and
  succeeded seconds later — but the Queue briefly showed it as "Failed"
  in between, and the eventual "done" row kept the stale error message
  since nothing ever cleared it). Now only reflects a failure in those
  display tables once retries are actually exhausted (`terminal`), and
  clears any leftover `error` on success.
- **Diagnosed overall ingest health** (see [the "no true background
  worker" gap in What's not built
  yet](#whats-not-built-yet) for the real finding — jobs can sit queued
  for hours with nobody noticing, purely because nothing drives the queue
  except an open browser tab).
- **`PLATFORM_ADMIN_EMAILS` production gotcha** — this env var
  (`.env.local`) had never actually been set on Vercel's **production**
  environment, only locally, so `/admin/organizations` (and its nav link)
  was invisible when logged into the real production app as its intended
  platform admin. Not a code bug — an env var genuinely has to be added
  in Vercel's own dashboard and a fresh deploy triggered; existing
  running deployments don't pick up a newly-added env var on their own.
  **If a platform-admin-only page/link seems to not exist for someone who
  should have access, check this first** before assuming a code/RLS
  issue.

### Four more confirmed gaps closed

Following a Dext/ApprovalMax competitive gap analysis (see the separate
roadmap artifact — not part of this repo), four items were researched
and built in one pass:

- **A real cron job now drives invoice ingestion**
  ([`/api/cron/ingest-process`](src/app/api/cron/ingest-process/route.ts),
  every 2 minutes in `vercel.json`) — closes the gap described above:
  `runNextIngestJob` ([`src/lib/ingest-queue.ts`](src/lib/ingest-queue.ts))
  used to only ever run via the browser polling `/api/ingest/process`.
  The cron finds orgs with actual `queued`/`processing` jobs and
  processes **one job per org per tick** — deliberately not a
  backlog-draining loop, since a single extraction can take 20-60s and
  `maxDuration` is 60s total; frequent scheduling drains a backlog, a
  bigger per-tick batch doesn't. Safe with the admin client: ingestion
  has no `auth.uid()` dependency, only `organizationId`.
- **Two vendor-matching inconsistencies fixed** — found while scoping a
  "real Supplier entity" feature (deferred as its own future migration;
  ~24 files touch normalized-text vendor matching today, too large to
  fold into this pass). The per-invoice "Possible duplicate" banner
  compared raw `trim().toLowerCase()` text while the list-pane duplicate
  grouping a few lines above correctly used `normalizeForMatching` — a
  punctuation-only vendor-name difference could pin a duplicate pair in
  the list without ever showing the banner on either invoice. The
  Document Search Supplier filter had the same gap (raw-string option
  list and matching, so two spellings of one vendor showed as two
  chips). Both now go through `normalizeForMatching` consistently.
- **Reports' project filter/grouping now sees per-line-item project
  splits** — `runReport`'s project filter and "group by project" used to
  read only the single `invoices.project_id` column, invisible to a bill
  split across multiple projects via `invoice_line_items` (migration
  0019). `invoice-list-report.ts` already solved this correctly for its
  own "Customers" column; `runReport` just never adopted the same
  approach. `filterInvoicesForReport` no longer checks `project_id`
  itself (it doesn't have per-invoice line-item data) — both callers now
  apply it as an explicit post-filter using a real per-invoice project
  set (`computeProjectIdsByInvoice`, `src/lib/reports.ts`), and grouping
  fans out: an invoice touching multiple projects contributes to every
  matching bucket, but still counts once toward the report's totals.
- **Real-time Discussion thread** (migration 0091: `alter publication
  supabase_realtime add table invoice_comments;`) — posting a comment
  used to only update the tab that posted it (`addComment`'s
  `revalidatePath`/`revalidateTag` is Next.js server-cache invalidation,
  not a push to other clients). `invoice_comments`'s existing SELECT RLS
  policy (`can_see_invoice`, migration 0008) already gates Postgres
  Changes subscriptions automatically, so no new policy was needed.
  `BillPanel.tsx` subscribes scoped to the open invoice and appends new
  comments to local state directly — the posting tab's own comment is
  skipped in the handler since it's already rendered via the existing
  server-action path.

### Support chat: a silent-failure bug, then a real performance bug

Reported live, two separate issues in the same feature:

- **A failed send looked identical to a successful one.**
  `SupportChatWidget.tsx`'s `send()` cleared the input before the POST
  request even resolved and never checked `res.ok` — if anything failed
  server-side (auth hiccup, no organization found, a DB error), the box
  went empty, nothing was ever saved, and nothing told the user it
  failed. Now waits for confirmation and shows the server's error inline
  before clearing the draft.
- **Sends took 3-5 seconds** — `GET /api/support/messages` (polled every
  4s while the widget is open, plus once right after every send) was
  calling `admin.auth.admin.listUsers({ perPage: 1000 })` on every
  request — a full platform-wide user fetch — just to check a
  message's author against `isPlatformAdmin`. Replaced with per-author
  `getUserById()` lookups scoped to the handful of people actually in
  that thread.

**The same `listUsers({ perPage: 1000 })` pattern was then found and
fixed in three more hot, user-facing paths** once the first instance
turned up: `addComment`'s @mention notification email (`dashboard-actions.ts`
— the case actually reported: posting a comment with an @mention took
3-5 seconds), `notifyNewApprovers`'s "it's your turn" email (fires on
every approve/reassign/stage-change), the rejection-email lookup, and
`/workflows`' own page load (resolved every org member's email for the
approver picker the same wasteful way, on every render). **If you ever
see `admin.auth.admin.listUsers({ perPage: 1000 })` show up again
anywhere in this codebase, it's almost certainly wrong** — resolve only
the specific person/people actually needed via `getUserById()`
(parallelized with `Promise.all` when there's more than one), not a
bulk fetch of the entire platform's users.

### Email links pointing to localhost in production

Reported live: clicking a link in an email (a mention, an "it's your
turn" assignment, a rejection, the daily reminder digest) opened
`localhost:3210` instead of the real site. Root cause: `NEXT_PUBLIC_APP_URL`
had the exact same gap as `PLATFORM_ADMIN_EMAILS` above — never actually
set in Vercel production, only documented in `.env.example`. Every one
of these email-building call sites had its own copy of
`process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3210"` — a
hardcoded localhost fallback with nothing smarter behind it. New shared
[`getAppUrl()`](src/lib/app-url.ts) consolidates all 7 scattered copies
into one: prefer `NEXT_PUBLIC_APP_URL`, fall back to Vercel's own
auto-populated `VERCEL_URL` (correct, if not prettily-branded, for any
deployment) rather than localhost — this was already the pattern used
for Stripe's checkout redirect (`dashboard-actions.ts`), just never
applied anywhere else. Setting `NEXT_PUBLIC_APP_URL` to the real
production domain is still the fix for pretty, branded links; the
fallback itself just can no longer point somewhere that can't possibly
work.

---

## Session log — 2026-08-30 (Supplier entity + admin MFA reset)

Two items pulled off the deferred list.

**Admin MFA reset**: recovery codes already solved the case that matters
most — a lone admin can always get back in with their own saved codes.
The remaining gap was someone who loses their device **and** never
kept their codes. `joinOrganizationAction` already grants a platform
admin `role: "admin"` on any org they join as support, so a single new
admin-facing **Reset** control next to a member's 2FA status in
Settings → Members (`resetMemberMfaAction`,
[`src/lib/admin-actions.ts`](src/lib/admin-actions.ts)) covers both "a
teammate is locked out" and "the whole org, including its only admin,
is locked out" — no separate platform-admin-only action was needed.
Verifies the caller is an admin of the target's own org and that the
target is actually a member of it before touching anything, then uses
`createAdminClient()`'s `auth.admin.mfa.listFactors`/`deleteFactor`
(bypasses RLS by necessity — this is one person's admin client turning
off *another* person's 2FA).

**Real Supplier entity (v1)** — migration `0092_suppliers.sql`. Before
this, supplier defaults, duplicate detection, and the Document Search
Supplier filter all matched on normalized vendor-name **text**, not a
stable id — two punctuation-variant spellings of the same vendor could
silently diverge. Scoped first: only 9 of the 24 files touching vendor
names actually do matching/grouping (the other 15 just display
`invoices.vendor_name` as plain text), making a real table tractable
instead of the multi-day full rewrite originally feared.

- New `suppliers` table (`organization_id`, `name`, a generated
  `name_normalized` column, `qbo_vendor_id`), RLS read-only for members
  — writes only ever happen via `createAdminClient()` at
  ingestion/resolve time, same as `supplier_defaults` already worked.
  `invoices.supplier_id` and `supplier_defaults.supplier_id` added,
  backfilled from whatever normalized vendor names already existed.
- `resolveSupplier()` ([`src/lib/matching.ts`](src/lib/matching.ts)):
  find-or-create by `(organization_id, normalizeForMatching(vendorName))`
  — first-seen spelling becomes the canonical display name, never
  silently renamed later.
- Switched to `supplier_id` everywhere real matching happens: ingestion
  (`invoices.ts`), `saveSupplierDefaults` and the "apply to all
  in-review invoices from this supplier" rematch, the Dashboard's
  duplicate-group key and Document Search Supplier filter, and —a real
  correctness fix, not just internal bookkeeping — statement
  reconciliation's vendor matching (`matchInvoicesForVendor` and
  `/statements/[id]`), which had been a raw case-insensitive
  `.ilike("vendor_name", …)`, already inconsistent with everywhere else.
- Deliberately **not** touched: `workflow-conditions.ts`'s Supplier
  condition (still plain `trim().toLowerCase()` — converting it means
  turning an admin-typed free-text field into a supplier picker, a real
  UX change with live behavioral stakes for existing workflows, not
  just a backend swap); `settings/suppliers/page.tsx` (a different,
  already-stable identity source — QBO's own vendor id); `reports.ts`'s
  vendor filter (a deliberate loose substring search for a human typing
  a partial name, not identity matching). No column drops —
  `vendor_name`/`vendor_name_normalized` stay exactly as they were,
  `supplier_id` is additive.
- The backfill has been confirmed complete: every existing invoice and
  `supplier_defaults` row now has a non-null `supplier_id`.
- Known gap, flagged not fixed: `resolveSupplier`'s find-or-create has
  no admin UI or merge tooling. It can create a real, permanent
  supplier row as a side effect of a read-only matching path (e.g.
  statement reconciliation falling back to a literal "Unknown vendor")
  — worth a dedicated look if supplier data quality becomes a visible
  problem.

---

## Session log — 2026-08-31 (Dashboard rewrite goes client-cached; scroll-prefetch; Settings navigation fixes)

### The Dashboard's master-detail view is now client-cached, not server-rendered per click

Before this, clicking between invoices was a real Next.js navigation —
`/dashboard/[id]`, fully server-rendered on every click. Fast, but not
"ApprovalMax fast": every click paid for a server round trip even for an
invoice you'd already had open. [`DashboardClient.tsx`](src/components/dashboard/DashboardClient.tsx)
now owns selection, filters, and the URL itself (`window.history.replaceState`,
never Next's router) with two TanStack Query caches: the invoice list
fetched once per org per session (`fetchDashboardListData`), and each
invoice's detail cached per-id (so revisiting an already-opened invoice
is instant, zero network request). Mutations still call the exact same
`"use server"` actions as before; each is wrapped (`invalidateAfter`) to
also invalidate the relevant query key on success, since a Server
Action's own `revalidatePath()` has no way to reach a separate
client-side query cache.

**Scroll-into-view prefetch**: as invoice rows scroll into view
(`IntersectionObserver` in [`InvoiceSelectionList.tsx`](src/components/InvoiceSelectionList.tsx),
`rootMargin: "200px 0px"` so a row warms just before it's actually
visible), its detail query warms in the background — clicking it later
feels the same as revisiting an already-cached one, without eagerly
loading every invoice in the org up front.

### Two real bugs this exposed, both root-caused by reading Next's own source, not by trial and error

**`revalidatePath("/dashboard", "layout")` in every mutation action**
(`dashboard-actions.ts`) was the first, and biggest: Next.js
automatically triggers a client-side router refresh of whatever route is
currently mounted whenever a Server Action calls
`revalidatePath`/`revalidateTag`, regardless of whether the client asked
for one. Since the Dashboard manages its own selection via client state,
that auto-refresh was silently resetting it on every single
approve/comment/reassign — the open invoice would randomly jump to a
different one (sometimes one that had merely been prefetched, never
actually clicked), or the detail pane would get stuck on "Loading…"
indefinitely. Removed from all ~31 call sites; `revalidateTag(INVOICES_TAG)`
stays, since that's what keeps the still-server-rendered consumers
(Queue, invoice detail pages) correctly reflecting a Dashboard mutation.

**The scroll-prefetch feature itself then re-triggered a version of the
same bug** — reproducible after 30-60 seconds of scrolling and idling,
with zero mutations involved. Root cause, confirmed by reading
`node_modules/next/dist/client/components/router-reducer/reducers/server-action-reducer.js`
and `handle-mutable.js`: **every** `"use server"` function call from
client code — a pure read like `fetchInvoiceDetail`, not just a
mutation — is dispatched through Next's Server Actions machinery, which
always applies a fresh RSC patch for whatever route Next's router still
thinks is current. Because this Dashboard's URL changes never go
through Next's router, that "current route" stays permanently frozen at
bare `/dashboard` from the last real Next navigation — so the
prefetch's high call volume (`fetchInvoiceDetail` used directly as a
TanStack Query `queryFn`) was remounting `DashboardClient` and wiping
its selection, purely from background reads. Fixed by moving that read
off the Server Action RPC path entirely, onto a plain Route Handler
([`/api/dashboard/invoice/[id]/route.ts`](src/app/api/dashboard/invoice/%5Bid%5D/route.ts))
fetched with a plain `fetch()` — JSON over HTTP never enters Next's
action-dispatch machinery, so it can't trigger the remount. Verified via
~6.5 minutes of cumulative idle time with heavy scroll-triggered
prefetch against a production build, monitored at the `window.history`
API level, with zero recurrences (one earlier, unexplained reproduction
right after a fresh server start couldn't be reproduced again — treat
as substantially fixed, not provably zero-risk).

### Shared shell: a real Dashboard link, and a page-wide horizontal-scroll bug

The shared sidebar ([`AppSidebar.tsx`](src/components/AppSidebar.tsx),
used by Settings/Billing/Workflows/Reports/Statements/Queue/etc.) had no
explicit way back to the Dashboard — only an unlabeled logo click in the
brand bar. Added a proper **Dashboard** nav item, first in the list.
That made the old per-page `<BackToDashboardButton />` (Queue, Add
invoice, Statements, Billing, Mentions, Needs split review) redundant —
removed from all six; the platform-admin `/admin/organizations` page has
no sidebar at all, so it keeps its own.

Reported live: clicking a Settings section pill (e.g. "Members") could
scroll the *whole page* sideways, cropping content on the left. Root
cause: every one of these pages' `<main className="mx-auto max-w-Nxl ...">`
is a flex item with auto horizontal margins, which — per the flexbox
spec — disables the container's default cross-axis stretch. Instead of
filling the visible pane's width, `<main>` fell back to shrink-to-fit
sizing and grew to match its widest unconstrained descendant (the
Members table), letting that table's own `overflow-x-auto` wrapper drag
the entire page horizontally instead of scrolling only within itself.
Added `w-full` alongside `mx-auto max-w-*` on every page carrying this
pattern (Settings, Queue, Billing, Statements, Reports, Workflows,
Notifications) so each page's internal overflow wrappers actually
contain their own overflow again.

### Settings: section pills are now real tabs, not a jump-to-anchor list

Clicking a pill used to just scroll a very long single page down to that
heading — everything above it stayed in the DOM, above the fold,
confusing on a page this long. Sections now show one at a time, driven
entirely by CSS `:target` (no client JS): `.settings-panel` is hidden by
default, shown when its `id` matches the URL's `#hash` or *contains* the
matching sub-anchor (`#invoice-email` lives inside Integrations,
`:has(:target)` catches that), and the page falls back to the first
panel (My profile) via `:not(:has(:target))` when nothing is targeted.

Making sections exclusive meant every place that redirects back to
`/settings` after an action also needed to carry (or recover) the right
`#hash`, or it would silently dump the user on "My profile" instead of
wherever they'd just acted: `inviteMember`'s three redirects now target
`#members` directly; the QBO OAuth callback's three redirects now target
`#integrations`; the MFA recovery-code sign-in flow now redirects to
`#security` (the banner already told users to look "under Security").
The QBO sync buttons and the default-tax-rate form can't set the hash
server-side (their redirect targets are shared with the non-tab
error/success banners), so the existing `ScrollPreserveForm`/
`ScrollRestorer` session-storage handoff — already used to survive a
redirect without losing scroll position — was extended to also save and
restore the active hash.

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
| `NEXT_PUBLIC_APP_URL` | Recommended | The site's real public URL (e.g. `https://flow.ufirst.co`), used by [`getAppUrl()`](src/lib/app-url.ts) to build absolute links in every email (mentions, assignments, rejections, the reminder digest) and the Stripe checkout redirect. **Must be set separately in Vercel** — same gotcha as `PLATFORM_ADMIN_EMAILS` below, confirmed live: left unset, every email link pointed at `localhost:3210` in production. Unset now falls back to Vercel's own `VERCEL_URL` (still correct, just an ugly `*.vercel.app` link) rather than localhost. |
| `PLATFORM_ADMIN_EMAILS` | No | Comma-separated emails allowed to create/manage organizations at `/admin/organizations` (see [Multi-tenant onboarding tool](#multi-tenant-onboarding-tool-adminorganizations)). Leave unset to hide that page entirely. **Must be set separately in each environment** — a value in `.env.local` has no effect on Vercel; set it there too (Project Settings → Environment Variables → Production) and trigger a fresh deploy, or the page/nav-link stays invisible in production even for the right email. |
| `CRON_SECRET` | Recommended | Any random string you choose; Vercel sends it as `Authorization: Bearer $CRON_SECRET` on cron-triggered requests to `/api/cron/reminders` (see [Deadlines, reminders & escalation](#deadlines-reminders--escalation-migration-0073)). Unset = the route runs unauthenticated. |
| `STRIPE_SECRET_KEY` | For billing | dashboard.stripe.com → Developers → API keys. Powers `/billing`'s "Pay now" and "Manage billing" (see [Billing & usage](#billing--usage)). No publishable key needed — the app only redirects to Stripe-hosted pages, never loads Stripe.js client-side. |
| `OPS_APP_URL` | No | Base URL of the separate "Ufirst Ops" internal app (see [Ufirst Ops](#ufirst-ops-separate-internal-app)). Only used to link out to it from `/admin/organizations`'s "Support chat" button. Leave unset to hide that button. |
| `NEXT_PUBLIC_SENTRY_DSN` | No | sentry.io → your project → Client Keys (DSN). Leave unset and error monitoring is a complete no-op — `Sentry.init` is never called, zero behavior change. |
| `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` | No | Only needed for source-map upload at build time (readable stack traces in Sentry) — the build succeeds without them, just skips that step. |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | No | dash.cloudflare.com → Turnstile → your site's site key. Leave unset and the CAPTCHA widget just doesn't render on the signup form. **Also requires** pasting the matching secret key into Supabase Dashboard → Authentication → Settings → CAPTCHA protection → Turnstile — that's where the actual verification happens. |

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
2. **Run the schema** — paste
   [`supabase/full_schema.sql`](supabase/full_schema.sql) (every migration,
   concatenated in order) into the SQL editor and run it once, or
   `supabase db push` if you have the CLI linked against
   [`supabase/migrations/`](supabase/migrations/) directly. Both are
   idempotent — safe to re-run. Only fall back to pasting individual
   migration files one at a time if you need to stop partway through for
   some reason; there's no need to otherwise.
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

**If `PLATFORM_ADMIN_EMAILS` is set** (see [Environment
variables](#environment-variables)): sign in once via `/login` with an email
in that list, then go to `/admin/organizations` (linked from the sidebar) —
it creates the org, its inbound invoice address, a default workflow, and the
first admin account in one step. This is the path for onboarding any org
after the first. See [Multi-tenant onboarding
tool](#multi-tenant-onboarding-tool-adminorganizations) for what it does
under the hood.

**Bootstrapping the very first org** (before you've set `PLATFORM_ADMIN_EMAILS`,
or if you'd rather not expose that page yet) still works the manual way —
once you have one admin bootstrapped via SQL, [Settings](#settings) can
invite everyone else into that org.

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

`/login` supports:

1. **Sign in** — password (`signInWithPassword`), magic link
   (`signInWithOtp`, the intended production fallback when a password is
   forgotten — doubles as password reset since there's no separate reset
   flow), or Google.
2. **Sign up** (`signUp`) — self-serve: anyone can create an account.
   Unlike everything else in this app (invite-only via
   `organization_members`), a brand-new signup gets its **own new
   organization**, as its admin, plus a **14-day free trial** (see
   [Billing & usage](#billing--usage)) — see
   [`src/lib/onboarding.ts`](src/lib/onboarding.ts)'s `ensureOrgForNewUser`,
   called from both `/auth/callback` and `/auth/confirm` right after a
   session is established. Idempotent (checks for an existing membership
   first), so it's safe to call on every auth completion, not just a
   user's first — an existing invited user completing a magic-link sign-in
   is a no-op. Both `ensureOrgForNewUser` and the platform-admin
   `createOrganizationAction` (`/admin/organizations`) now share one
   `bootstrapOrganization()` helper (`src/lib/admin-actions.ts`) for the
   actual org-insert + membership + default-workflow bootstrap — a real
   gap this closed: `ensureOrgForNewUser` used to have its own duplicated,
   incomplete version of this with no default-workflow step at all, which
   would have left a self-signed-up org's Approve/Reject silently broken
   forever (`decide()` no-ops when `invoice.workflow_id` is null — same
   failure mode already documented in [Multi-tenant onboarding
   tool](#multi-tenant-onboarding-tool-adminorganizations) for the
   admin-provisioned path, just never fixed on this one). The signup form
   collects a company name (`company_name` in `user_metadata`) and an
   ApprovalMax-style marketing opt-in checkbox
   (`profiles.marketing_opt_in`, migration 0086).
3. **Google, Microsoft, or Apple** (`signInWithOAuth({ provider })` —
   Supabase's provider keys are `google`, `azure` (Microsoft/Office 365 —
   Azure AD/Entra ID under the hood, covers both work/school and personal
   Microsoft accounts once the Azure app is registered as multi-tenant),
   and `apple` (Sign in with Apple — what an iCloud-email user uses).
   Same `?code=` PKCE exchange as magic link for all three, so
   `/auth/callback` needed zero provider-specific code. Azure additionally
   requests the `email` scope explicitly (`continueWithProvider` in
   `login/page.tsx`) — Supabase's own docs call out that Azure doesn't
   return an email by default, and both the app and `ensureOrgForNewUser`
   key off it.

   **Each needs setup only you can do** — Supabase never sees your
   provider credentials until you paste them into its dashboard:
   - **Google**: Google Cloud Console → APIs & Services → Credentials →
     OAuth client ID → Web application; authorized redirect URI is your
     Supabase project's `https://<project-ref>.supabase.co/auth/v1/callback`.
     Paste the Client ID/Secret into Supabase → Authentication → Providers → Google.
   - **Microsoft**: Azure Portal → Microsoft Entra ID → App registrations
     → New registration (set "Supported account types" to multi-tenant +
     personal Microsoft accounts if you want both Office 365 and
     outlook.com/iCloud-style personal sign-in) → add the same Supabase
     callback URL as a redirect URI → create a client secret under
     Certificates & secrets. Paste the Application (client) ID and that
     secret into Supabase → Authentication → Providers → Azure.
   - **Apple**: notably more involved — requires a paid Apple Developer
     Program membership. Create a Services ID + a Sign in with Apple
     private key in developer.apple.com, verify your domain, and set the
     same Supabase callback URL as the return URL. Paste the Services ID,
     Team ID, Key ID, and private key into Supabase → Authentication →
     Providers → Apple.

   Nothing to set in this app's own env vars for any of the three —
   Supabase holds those credentials itself. Until a given provider is
   configured, its button surfaces Supabase's own error inline rather
   than silently failing.

Uses Supabase's **PKCE** flow by default (`@supabase/ssr`'s browser
client sets `flowType: "pkce"`), so the magic-link email and every OAuth
provider redirect land on `/auth/callback?code=...`, which exchanges the
code for a session server-side
([`src/app/auth/callback/route.ts`](src/app/auth/callback/route.ts)).

There's also [`src/app/auth/confirm/route.ts`](src/app/auth/confirm/route.ts),
which handles Supabase's alternate `token_hash` + `type` email-confirmation
format (its documented pattern for customizing email templates, and also
what `supabase.auth.admin.generateLink()` returns, or a brand-new email/
password signup's own confirmation link) — separate from the `?code=`
PKCE flow that `/auth/callback` handles.

**Email confirmation on signup** is a Supabase Auth setting (Authentication
→ Settings → "Confirm email"), not app code — with it on (the default),
`signUp()` returns no session and the login page shows a "confirm your
email" state; with it off, `signUp()` returns a live session immediately
and the new user skips straight to their brand-new org's dashboard.

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

### Two-factor authentication (TOTP)

Per-user, self-service, opt-in — **not** admin-mandated. Built entirely on
Supabase Auth's own `auth.mfa.*` API (no third-party service): a
**Security** section on `/settings` ([`SecurityMfaSection.tsx`](src/components/SecurityMfaSection.tsx))
lets anyone enroll a TOTP factor (any authenticator app — Google
Authenticator, Authy, 1Password, …), shown as a QR code + manual-entry
secret, confirmed with a 6-digit code before it turns on. Once enrolled,
`middleware.ts` enforces it on every request: `getAuthenticatorAssuranceLevel()`
compares the session's current level against what the account actually
requires, and a mismatch (password/OAuth succeeded, but the 6-digit step
hasn't happened yet) redirects to `/login/mfa` — same 5-second timeout
guard as the existing `getUser()` call in that file, so a slow Auth call
never hangs every request. An admin can only see the Members table's
"2FA" status column (Enabled/Disabled) and remind someone directly — they
cannot enroll, disable, or bypass 2FA on another user's account.

**Real pre-existing bug found and fixed while building this**: the
Members table's "2FA" column had silently shown "Disabled" for *everyone*
since it was originally built — `admin.auth.admin.listUsers()` (the bulk
endpoint `/settings` already used) doesn't return a `factors` field per
user at all, confirmed by diffing its raw response against the
single-user `admin.auth.admin.getUserById()` endpoint, which does.
`settings/page.tsx` now fetches each member's status individually via
`getUserById` instead.

**Recovery codes (migration 0090)** — the real gap this closed: once
enrolled, there was genuinely no way back in for someone who lost their
authenticator device, not even for the org's own admin (and if the
*only* admin lost theirs, nobody in the app could help at all). Supabase's
`auth.mfa` API has no native backup-code concept, so this is built
entirely at the app layer
([`src/lib/mfa-recovery.ts`](src/lib/mfa-recovery.ts)): right after
enrollment (and again via "Regenerate recovery codes" any time after),
8 one-time codes are generated, hashed, and shown to the user exactly
once. Using a valid code at `/login/mfa`'s "Use a recovery code instead"
consumes it and removes the user's TOTP factor via the **admin client**
— deliberately not the user's own session, since some Supabase MFA
management calls may require an already-aal2 session, which a
locked-out user by definition doesn't have — then routes to Settings
with a prompt to re-enroll. A code is a one-time "prove it's you, then
start over" token, not an ongoing alternate MFA factor, same as how
GitHub/Google backup codes work.

**Admin reset (added 2026-08-30)** — the one remaining gap: someone who
loses their device *and* never kept their recovery codes. An admin-only
**Reset** control next to a member's 2FA status in Settings → Members
(`resetMemberMfaAction`) turns off their TOTP factor via the admin
client, after verifying the caller is an admin of that same org and the
target is actually a member of it. No separate platform-admin action
was needed for the "whole org, including its only admin, is locked out"
case — `joinOrganizationAction` already grants a platform admin
`role: "admin"` on any org they join as support, so "join as support"
then the same Reset button covers it. See [Session log —
2026-08-30](#session-log--2026-08-30-supplier-entity--admin-mfa-reset).

### Error monitoring and signup abuse protection

Both fully coded, both currently **no-ops** — neither has ever run in
production because the external accounts they depend on don't exist yet:

- **Sentry** (`sentry.client.config.ts` / `sentry.server.config.ts` /
  `sentry.edge.config.ts`, loaded via [`src/instrumentation.ts`](src/instrumentation.ts))
  — standard `@sentry/nextjs` App Router setup, client/server/edge error
  capture plus source-map upload wired into `next.config.js`. Each
  config only calls `Sentry.init` `if (process.env.NEXT_PUBLIC_SENTRY_DSN)`
  — unset, this is a genuine no-op, not degraded functionality.
  [`src/app/global-error.tsx`](src/app/global-error.tsx) is new too — there
  was no global error boundary at all before this, so an error escaping
  every route's own boundary just showed Next's generic crash page with
  nothing reported anywhere. `GET /api/health` (unauthenticated, checks
  the DB connection) exists for whichever external uptime pinger gets
  set up — no uptime monitor is actually running yet.
- **Cloudflare Turnstile** ([`src/components/TurnstileWidget.tsx`](src/components/TurnstileWidget.tsx))
  — a minimal hand-rolled widget (no extra dependency for one script) on
  the signup form only, forwarding its token as `signUp()`'s
  `captchaToken` option. The actual verification happens inside
  Supabase's own Auth server (Authentication → Settings → CAPTCHA
  protection), not in this app's code — this app only renders the
  widget and passes the token through. Without `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
  set, the widget doesn't render and signup works exactly as it did
  before this existed.

Both were built in response to a real gap: the public signup form had
zero abuse protection (nothing stopped scripted spam-creation of junk
organizations), and there was no way to find out about a production
error except a customer reporting it.

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

**Getting out of the Approval matrix modal ([`StepApproversManager.tsx`](src/components/StepApproversManager.tsx)).**
Reported as "awkward to get out of that screen" once a step had several
approvers saved: the whole overlay (header included) scrolled as one
block, so scrolling down to see a long approver list scrolled the ✕
close button away too, and there was no other way to close it — no
click-outside, no Escape. Fixed by pinning the header (`shrink-0`)
outside the scrolling area so only the approver list scrolls under it,
and adding both click-outside-to-close (an `onClick` on the backdrop,
`stopPropagation`'d on the card itself) and Escape-to-close.

**Each workflow is collapsible.** With several workflows configured,
each one's full contents (steps, approval matrices, workflow items) used
to always render in full — a page-length scroll to get from one
workflow to the next. A chevron next to the workflow name toggles that
whole body; the name/default badge and admin rename/delete controls stay
visible either way, so nothing needed to open a workflow to rename or
delete it. [`CollapsibleWorkflowSection.tsx`](src/components/CollapsibleWorkflowSection.tsx) —
a separate component from the existing `CollapsibleSection.tsx` (used by
BillPanel's accordion panes: whole header is the click target, plain-
string title, no persisted state), since this one needed a header with
live server-action forms that stay visible and clickable while
collapsed. Collapsed/expanded state is remembered per workflow in
`localStorage`, so it survives a reload.

**A step nobody matches gets skipped, not stuck.** Reported live: a
3-stage matrix workflow (PM Approval → CO Team Approval → Accounting)
where the PM sometimes hands an invoice straight to the CO team, skipping
PM Approval entirely for that one invoice — since nobody's condition
matched PM Approval for it, the invoice got stuck there with "No approver
currently matches this invoice at step 1 ... It can't be approved as-is,"
requiring a manual admin Reassign/Stage every time. A matrix workflow's
steps were never meant to all apply to every invoice — an unmatched step
(no conditional approver's rules apply, and no default approver) just
isn't one of THIS invoice's stages, so `reviewComplete` (entering the
workflow) and `decide()` (advancing after each approval) both now call
`firstMatchingStepFrom` (dashboard-actions.ts) to land on the first step
from there onward that actually has a matching approver, skipping past
any that don't. Only when nothing from the current step through the last
one matches does the old warning still surface — a genuinely
unconfigured workflow, not a routing gap for one invoice.

**One approver, two alternative rule sets ("OR" instead of "AND").** Gap
found comparing a real ApprovalMax export against this app: one of their
approvers needed "approve if Customer matches A and Supplier matches B,
**or** if Class matches C" — two independent condition sets for the same
person on the same step. Conditions on one approver row are always AND'd,
so that's expressed by adding the **same person twice** to the step, each
row with its own condition set (`approval_workflow_step_approvers` no
longer has a `unique(step_id, approver_user_id)` constraint as of
migration 0073) — `effectiveApproversForStep`/`is_eligible_approver`
already looped over every row for a given approver and returned them as
eligible if *any* row's conditions matched, so this needed only the
constraint drop, no matching-logic change. The Approval matrix modal has
a hint about this; no UI change was needed since the approver dropdown
was never filtered to exclude already-added people.

---

## Projects & visibility

`projects` (Settings-managed) are org-scoped customers/jobs/classes. Three
separate things depend on them:

1. **Access control** — a `user`-role member can only see an invoice if
   they submitted it, or `is_eligible_approver()` says they'd end up as
   the effective approver of some step on the invoice's workflow — i.e.
   either they're a default approver on some step, or a conditional
   approver whose Customer condition (among others) matches a project the
   invoice touches. Enforced in Postgres, not the UI. (Through migration
   0026, this ran through `approval_workflow_projects` — "any approver on
   a workflow linked to this project" — a coarser, project-linked model;
   0027 replaced it with the per-approver-condition check described
   above, and dropped that table. **Migration 0067** then dropped a
   further "or the invoice has no project at all" exception that used to
   give every member blanket visibility into unassigned invoices
   regardless of eligibility — see the permissions-overhaul session log
   entry above.)
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
- **Matched by `supplier_id`** (a real `suppliers` entity, resolved via
  `resolveSupplier()` — see [Session log —
  2026-08-30](#session-log--2026-08-30-supplier-entity--admin-mfa-reset)),
  same identity used for [duplicate detection](#document-search) and the
  Document Search Supplier filter.
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
non-cancelled/rejected invoices from the same supplier (`supplier_id`)
with the same invoice number. Any invoice in a duplicate group gets an orange
left-border marker in the list, and **every group is pinned together at
the top of the list pane** (in front of the normal filter/sort order) so
the matches are visible without having to hunt for them; opening one also
shows a banner linking to the others, noting a differing amount as a
likely price-corrected resubmission rather than a true duplicate. Purely
informational — nothing is auto-blocked or auto-linked.

**Natural-language search (migration 0078)**: the same quick-search box
([`SearchInput.tsx`](src/components/SearchInput.tsx)) doubles as an AI
search — typing a full sentence ("show me invoices from Sat Metal that
aren't approved yet") gets translated into the exact filter fields above,
not a raw database query. A small heuristic (4+ words, or a cue word like
"from"/"not"/"waiting"/"approved") decides whether a submitted search is a
sentence or a literal vendor/file/invoice# lookup — most typed searches
never touch the AI path and stay instant and free, exactly as before.
[`src/lib/nl-search.ts`](src/lib/nl-search.ts) sends the org's real
vendor/project/member names to a cheap model (`anthropic/claude-haiku-4.5`
by default, `OPENROUTER_SEARCH_MODEL` to override) and only accepts values
back that actually exist in those lists — a bad or hallucinated answer
degrades to "no match" or a slightly-wrong filter, never a cross-org leak
or an arbitrary query. Cost is logged the same way as extraction (see
[Ufirst Ops](#ufirst-ops-separate-internal-app)), with
`purpose = 'search'`. On any failure (no `OPENROUTER_API_KEY`, a bad
response, an empty result) it falls back silently to the plain literal
search on the typed text.

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

## Deadlines, reminders & escalation (migration 0073)

> **Status (2026-08-28): migration applied, code deployed.** The earlier
> note here flagged 0073 as not-yet-run due to a Supabase incident; the
> migration has since been applied (verified: `deadline_days`,
> `current_step_entered_at`, `escalated_at` all exist in the live DB).
> `CRON_SECRET` should still be set in Vercel (and `.env.local`) so the
> daily digest/escalation cron can't be hit by outsiders; until it is, the
> route runs unauthenticated.

Another gap found comparing a real ApprovalMax export: their steps carry
a **Deadline** (e.g. "4 days"), and — separately reported — some
approvers just sit on bills for days with nothing prompting them.

- **Per-step deadline** — `approval_workflow_steps.deadline_days`
  (nullable int, `null` = no deadline, the prior behavior), set in the
  step's inline form on `/workflows` next to approval mode. `invoices`
  tracks `current_step_entered_at`, reset by every code path that
  changes `current_step_order` (`decide`, `reviewComplete`,
  `backToReview`, `setInvoiceStage`, `overrideStatus` — see
  `stepEnteredReset()` in
  [`dashboard-actions.ts`](src/lib/dashboard-actions.ts)) — that's the
  clock "days on this step" is measured from. `escalated_at` tracks
  whether an invoice has already triggered the one-time admin
  escalation below, so it isn't re-sent every day it stays stuck.
- **Daily digest, every approver** — a cron job
  ([`src/app/api/cron/reminders/route.ts`](src/app/api/cron/reminders/route.ts),
  scheduled 13:00 UTC in `vercel.json`) computes every `on_approval`
  invoice's required approver(s)
  ([`src/lib/reminders.ts`](src/lib/reminders.ts), reusing
  `requiredApproversFor`/`effectiveApproversForStep` with the admin
  client since a cron run has no signed-in user) and emails each
  approver **one** digest listing everything waiting on them — "You have
  25 bills waiting for your approval," each with a direct link, days-on-
  step, and an OVERDUE flag once it's past the step's deadline. This is
  the reminder mechanism: rather than a one-time notice easy to miss, an
  approver who lets things sit sees it called out again every single
  day. Sent regardless of whether any deadline is even configured — the
  digest is "where do things stand," the overdue flag is deadline-driven.
- **Escalation to admins** — an invoice past `deadline_days +` a 2-day
  grace period gets a one-time email to every org admin ("X has been
  sitting N days on step Y, waiting on Z") and its `escalated_at` is set
  so it isn't repeated; a step change (approve/reassign/reject) clears
  `escalated_at` via `stepEnteredReset()`, so a bill that gets moving
  again and later stalls at a *different* step can escalate again.
- The route checks `Authorization: Bearer $CRON_SECRET` (set the env var
  in both Vercel and `.env.local`) so it can't be hit — and made to spam
  every user's inbox — by an outside request; if `CRON_SECRET` isn't set
  it runs unauthenticated (fine for local testing, not for production).
  It's declared `export const dynamic = "force-dynamic"` — without that,
  Next.js has no signal this route needs per-request execution (it reads
  `request.headers` directly rather than `next/headers`' `headers()`,
  and touches no cookies) and would optimize it as a static route, built
  and cached once instead of re-run on every cron trigger.

---

## Brand (ufirst)

The app's visual identity comes from ufirst's brand package
(`ufirst_brand_brief.md` — colors, fonts, logo files), applied as a
preview mockup first (an Artifact) and implemented once approved, rather
than recolored blind. Applied incrementally, not a one-shot recolor of
every screen:

- **Tokens** — `tailwind.config.ts` adds `brand-ink` / `brand-navy` /
  `brand-green` / `brand-green-dark` / `brand-green-light` / `brand-mist`
  / `brand-line` / `brand-muted` (hexes match the brief exactly) alongside
  the existing slate/blue palette, which most of the app still uses —
  these are additive, adopted screen-by-screen.
- **Fonts** — Inter (body) and Archivo (display, `font-display` /
  `.font-display` — extra-bold, used for headlines and logo lockups only,
  per the brief's own rule that italic Archivo is headline-only, never
  body) loaded via `next/font/google` in
  [`layout.tsx`](src/app/layout.tsx).
- **Favicon** — [`src/app/icon.png`](src/app/icon.png) /
  `apple-icon.png`, Next's file-based icon convention (auto-served, no
  manifest or `<link>` tags needed). Composited from the package's
  rectangular "u1" icon: the source is a 1200×827 rounded card with
  transparent corners, so a plain pad-to-square left visible transparent
  notches where the corners used to be — instead it's centered on a
  fresh `#091727` (the documented Navy Ink, not a sampled pixel — an
  early attempt sampled a pixel that landed on the green "1" glyph
  instead of the background) square canvas with matching rounded outer
  corners, giving one seamless card at any size.
- **Login page** ([`login/page.tsx`](src/app/login/page.tsx)) — a navy
  hero panel (hidden below `md:`) with the white wordmark and one of the
  brief's own "signature lines" plus a documented proof point, next to
  the sign-in form with the color wordmark, green CTA, and green-tinted
  focus rings. Copy is pulled verbatim from `ufirst_brand_brief.md`, not
  invented.
- **Dashboard sidebar** — a navy strip with the white wordmark above the
  org name (`src/app/dashboard/[[...id]]/page.tsx`) — there was no
  existing top bar to put it in, just the sidebar.
- **Email footer** ([`notify.ts`](src/lib/notify.ts)) — the plain-text
  "Flow by UFIRST" footer line is now the wordmark image, referenced by
  absolute URL (`NEXT_PUBLIC_APP_URL`) since email clients fetch images
  remotely rather than from the bundle. Per-type accent colors (blue
  mention / green assigned / red rejected) are semantic state, not brand
  identity, and were left alone.
- Logo source files live in `public/brand/` (`ufirst-wordmark.png`,
  `ufirst-wordmark-white.png`, `ufirst-icon.png`).

---

## Dashboard UI

`/dashboard/[[...id]]` ([`src/app/dashboard/[[...id]]/page.tsx`](src/app/dashboard/[[...id]]/page.tsx))
is a master-detail interface. The server renders the initial page load;
after that, [`DashboardClient.tsx`](src/components/dashboard/DashboardClient.tsx)
owns selection/filters/URL client-side over two TanStack Query caches (the
invoice list, and each invoice's detail keyed by id) — see [Session log —
2026-08-31](#session-log--2026-08-31-dashboard-rewrite-goes-client-cached-scroll-prefetch-settings-navigation-fixes)
for the full architecture and two real bugs it took to get there:

- **Sidebar**: org name + inbound email address, and nav filters computed
  from real data — All invoices, Pending Review (admin/auditor only),
  **Requires my approval**, Created by me, Approved, Rejected. Each shows a
  live count.
- **Search**: a quick text box (`?q=`, vendor/file/invoice #) plus the full
  [Document search](#document-search) panel for everything else.
- **List pane**: clicking a row updates client state and the URL
  (`/dashboard/[id]?...`, filters preserved) without a server round trip
  — a previously-opened invoice renders instantly from cache, and rows
  scrolled into view prefetch their detail in the background before
  they're ever clicked. Admin users get a **checkbox per row**; with one
  or more selected a
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

**The @mention list is scoped per-invoice, not every org member.**
`mentionableMemberOptions` (dashboard page) narrows it to whoever's an
eligible approver on some step of THIS invoice's workflow — reusing
`eligibleApproverIdsForInvoice` (the same rule as the `user`-role
visibility restriction, migration 0067) — plus the submitter, plus every
admin unconditionally (admins can see and act on anything, so they're
always reachable). Previously it was every org member regardless of
project: mentioning someone outside the invoice's project sent them a
notification linking to an invoice they couldn't even see.

**Hardened server-side, not just in the dropdown.** The scoped list above
is only a UI convenience — `mentioned_ids` is client-supplied, so
`addComment` couldn't actually trust it. `eligibleMentionIdsForInvoice`
(dashboard-actions.ts) is the real gate: queried fresh per comment (an
approver on ANY step of the invoice's workflow, its submitter, or an
admin), and `addComment` now intersects the requested ids against it
before creating any notification/email — a crafted request naming
someone outside the project no longer gets through just because they
happen to be an org member.

**"It's your turn" notifications** (migration 0069, `notifications.type =
'assigned'`): whenever an invoice's responsibility actually moves to a new
approver — first entering the approval workflow (`reviewComplete`),
advancing past a completed step (`decide()`, including its self-heal
branch), or an admin reassigning/setting a specific stage
(`reassignApprover`/`setInvoiceStage`) — `notifyNewApprovers`
(dashboard-actions.ts) fires the same in-app row + best-effort email
pattern as mentions, via the new `sendAssignedEmail`
([`src/lib/notify.ts`](src/lib/notify.ts)). Reuses `firstMatchingStepFrom`'s
already-resolved approver list (see the matrix-workflow skip-step section
above) rather than re-querying who's eligible a second time. Never
notifies whoever just took the action that caused the move.

Both email types now share one visual template (`emailShell` in
`notify.ts`) — a small table-based card (safe across Gmail/Outlook/Apple
Mail, unlike flexbox/grid) with a colored accent bar, a bold one-line
headline, optional context, and a real button — replacing the original
bare "X did Y" paragraph. Mentions stay blue; assignment emails are green,
so the two read as visually distinct without needing to read the subject
line first.

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

`/billing` — Flow's own billing: four fixed monthly plans
([`src/lib/plans.ts`](src/lib/plans.ts)), not an admin-editable
$/document rate (that model — `organizations.usage_rate_usd`,
`saveUsageRate`, `UsageRateForm` — is gone; the column stays on the table,
just unread now).

| Plan | Price/mo | Docs included | Overage/doc |
|---|---|---|---|
| Starter | $49 | 100 | $0.45 |
| Growth | $99 | 200 | $0.35 |
| Scale | $199 | 400 | $0.25 |
| Detailed | $299 | 700 | $0.20 |

Priced against comparables actually researched: ApprovalMax's old flat
tiers ($59.40/$95/$133.10/mo, before they too moved to usage-based
pricing in Aug 2026) and Dext's per-user-bundle pricing (~$25–31/mo for 5
users + 250 docs). The pitch: Flow combines what ApprovalMax (approval
routing) and Dext (invoice OCR/extraction) do as two separate products
into one, priced below buying both. `includedDocs` on each `Plan` is the
single source of truth read live by the Billing page's display, its
overage calculation, and the actual Stripe overage-invoice line items
(`dashboard-actions.ts`) — changing a plan's doc count is a one-line edit
in `plans.ts`, nothing else to update.

**Detailed is also the plan that decides extraction depth, not just
price/volume** — see [Simple vs Complex extraction
mode](#simple-vs-complex-extraction-mode) below: an org on the Detailed
plan (or in an active trial) gets today's full line-by-line extraction;
every other plan (or no plan at all) gets one line item per invoice.
There's no separate switch for this — changing an org's plan is the only
lever, on purpose, so billing and features can't drift apart.

**14-day free trial** (self-serve signup only — see [Authentication →
self-serve signup](#authentication)): `organizations.trial_ends_at`
(migration 0085) grants full access to every feature, including
Statement Reconciliation and Complex extraction, with no plan chosen yet.
`isTrialActive`/`isOrgLocked` (`plans.ts`) soft-lock the org to read-only
(`decide()` and manual upload both refuse; everything else, including
inbound email, still works) once the trial lapses with no plan ever
picked — `TrialBanner.tsx` shows the countdown, then the "choose a plan"
prompt. A platform admin can push a trial's expiry out from
`/admin/organizations` ("+14 days", `extendTrialAction`). An org
provisioned the old way (via `/admin/organizations`'s "Create
organization" form) has no trial clock at all — `trial_ends_at` stays
null forever, always billed by hand.

- One `usage_events` row per document accepted into the pipeline: an
  inbound-email attachment (after the signature-image filter) or a manual
  upload. Recorded at **acceptance**, never at retry time, so a document
  that fails and gets re-queued still counts exactly once (migration 0061).
- `organizations.plan` (migration 0075, nullable — no plan chosen yet is a
  valid state) + `plan_selected_at`. `selectPlan()` sets it — admin-only,
  a plain `<form action>` (not a client-wrapped wrapper like the old rate
  editor), so failures redirect back to `/billing?error=...` rather than
  returning a value.
- **"This month's charge" is plan price + overage for the current
  calendar month** (`usage_events` since the 1st), not a lifetime running
  total the way the old rate model was — a flat monthly plan fee doesn't
  make sense charged against all-time usage. The "By month" table still
  shows full history, each month priced at the *current* plan's rate
  (there's no historical per-month plan tracking, same limitation the old
  rate model already had — it only ever tracked the latest rate too).
- **Stripe Checkout** ("Pay now") charges that amount via Stripe's hosted
  page — one line item for the plan fee, a second for overage only when
  there's overage that month (always USD, regardless of the customer's
  own country). Requires `STRIPE_SECRET_KEY`; without it the page shows
  "Stripe is not connected". Success/cancel redirect back to
  `/billing?payment=success|cancelled`. `NEXT_PUBLIC_APP_URL` sets the
  redirect base (defaults to VERCEL_URL). **Real production bug hit and
  fixed**: the request sent `metadata: JSON.stringify({...})` as a single
  form field — Stripe's form-encoded API needs bracket notation
  (`metadata[organization_id]=...`) per key for object parameters, not a
  JSON blob under a bare `metadata` field, and rejected the whole request
  with a 400. `ensureStripeCustomer`'s own customer-creation call already
  used the correct bracket form; only the checkout session had this bug.
- **Recent documents is collapsible** (`CollapsibleSection`, collapsed by
  default) — the list runs up to 50 entries.
- **Stripe customer + Billing Portal (migration 0074).** Every org gets a
  persistent Stripe Customer (`organizations.stripe_customer_id`), created
  lazily on first "Pay now" or "Manage billing" click via a shared
  `ensureStripeCustomer()` helper — previously every Checkout session was
  anonymous, so there was nothing for a Billing Portal session to attach
  to. **"Manage billing"** opens Stripe's own hosted Billing Portal, where
  a customer sees past receipts and updates their saved payment method
  themselves — Flow never builds card-entry UI of its own (`no Stripe.js
  client-side either — the page only redirects to Stripe-hosted URLs`).
  The Billing Portal must be activated once in the Stripe Dashboard
  (Settings → Billing → Customer portal) or `createBillingPortalSession`
  surfaces Stripe's own error message explaining that, rather than a bare
  status code — the fix there is a Stripe setting, not a code change.
- The visual redesign (usage trend bar chart, brand-colored cards) uses
  the same `brand-*` Tailwind tokens as [the rest of the ufirst brand
  work](#brand-ufirst) — no new dependency for the chart, just a row of
  divs sized by `height: %`.

---

## Simple vs Complex extraction mode

Two extraction depths, controlled by **plan alone** — not a separate
switch anywhere:

- **Complex** (today's default behavior) — full line-by-line extraction,
  as documented in [Field extraction](#field-extraction-openrouter-model-agnostic):
  one `invoice_line_items` row per line the model finds on the document.
- **Simple** — Dext-style: exactly **one** line item per invoice, using
  the document's own printed **subtotal** as the amount (not the total —
  that would double-count tax once the existing tax-rate math applies),
  tax auto-derived from the extracted rate (or a saved [supplier
  default](#supplier-default-rules)'s rate, which still wins), and
  category from the vendor's saved supplier default — landing blank for a
  brand-new vendor, same one-time "set it and it's remembered" flow
  supplier rules already provide for Complex mode.

`extractionModeForOrg(plan, trialEndsAt)` in
[`src/lib/plans.ts`](src/lib/plans.ts) is the single source of truth:
**Complex** only for the **Detailed** plan or an active trial, **Simple**
for every other plan (or no plan at all). The model still extracts the
whole document exactly the same way either way — same `extractInvoiceFields`
call, same OpenRouter cost — the only difference is which line item(s)
[`buildSimpleLineItem`](src/lib/invoices.ts) vs. the normal per-line
mapping build from that extraction, in both ingestion
(`createInvoiceFromFile`) and re-extraction (`reExtractInvoiceCore` in
`dashboard-actions.ts`).

**This started as an independent per-org toggle (`organizations.extraction_mode`,
migration 0088), then was deliberately redesigned to derive from plan
instead** (migration 0089 drops that column again) — explicit ask: "if I
change the plan, everything changes" so a customer always gets exactly
what their plan promises, with no possibility of an org ending up on a
plan/extraction combination nobody actually chose. **Do not re-add a
separate `extraction_mode` switch** — if a customer needs a different
extraction depth, that's a plan change, made either by them
(`selectPlan()` on `/billing`) or a platform admin (the **Plan** column on
`/admin/organizations`, `setOrgPlanAction` — replaced what used to be a
Simple/Detailed toggle there, since a raw mode label didn't say anything
about what the org was actually being billed).

**Manual "Convert to one line"** — a per-invoice escape hatch, independent
of plan/mode: in the Bill panel's Category-details table, checking two or
more line items reveals **"Convert to one line"** in the same toolbar as
Save/Clear/Delete selected. It merges only the **checked** lines — any
line left unselected is untouched — and the **first selected line (by
line order) wins outright**: its category/class/project/tax_rate are used
exactly as they already are, no blending, no supplier-default override;
only the amount becomes the sum of the selected lines' amounts (a null
rate on that first line still falls back to the org's default rate, same
as everywhere else). `recomputeInvoiceTotals` already sums across
whatever line items exist after any edit, so leaving the untouched lines
alone needs no special-casing in the totals math.

**Real bug found and fixed via a post-ship audit**: `buildSimpleLineItem`
originally used only the extracted `subtotal`, with no fallback — a
document where OCR found a total but no separately-printed subtotal
produced a **$0 line item** (a null amount is treated as `0` by
`computeLineItemTotals`). Fixed to fall back to `total_amount`, matching
the same fallback the Complex-mode "no line items extracted" path already
used.

---

## Statement Reconciliation (migrations 0081-0084)

Plan-gated (`hasStatementReconciliation()` in `plans.ts` — Detailed plan
or an active trial, same trial-time-full-access rule as everything else):
upload a vendor's own account statement PDF, and Flow matches its listed
invoices/amounts against what's actually in the system for that vendor,
surfacing which ones are missing so the office can chase the vendor for
copies before month-end close.

- **Upload** (`/statements`, `uploadAndReconcileStatement`) — the
  statement is extracted the same mupdf+OpenRouter way invoices are
  (`src/lib/extract-statement.ts`, a lean sibling of `extract-invoice.ts`:
  just line date/reference/amount, no full invoice shape needed), stored
  as `vendor_statement_lines`, then matched against this org's own
  invoices from the same supplier by invoice number + amount.
- **Detail page** (`/statements/[id]`) shows matched lines (linking
  straight to the invoice, opening in a **new tab** — fixed after being
  reported as disruptive to lose the statement view on every click) and
  missing ones, with a one-click **"Email vendor"** draft to chase the
  gaps.
- **"Reconcile again"** button re-runs the matching for the statement's
  current supplier without re-uploading — added after a real bug: a
  statement showed a real, already-in-Flow invoice as "missing" purely
  because the vendor's name had since been corrected/normalized
  differently. Root cause was migration 0081 only ever adding
  SELECT/INSERT RLS policies on `vendor_statement_lines`, never an UPDATE
  one — Postgres RLS defaults to deny with no matching policy, so the
  re-match's write silently touched zero rows, with no error surfaced
  anywhere. Migration 0084 adds the missing policy. **If a future
  statement-matching change silently doesn't seem to "take," check for
  exactly this shape of gap first** — it's happened at least twice now in
  this codebase (see 0023/0025/0050 in the migration history above for
  the earlier instances).
- The upload form also has an **X** to clear a chosen file before
  submitting, instead of it being stuck showing the old filename until a
  new one is picked.

---

## Support chat (migration 0071)

One continuous chat thread per organization — any member can read and
post (RLS: `is_org_member`, no role restriction — reaching support
shouldn't need admin permissions). **A floating popup
([`SupportChatWidget.tsx`](src/components/SupportChatWidget.tsx)), not a
full-screen page** — the original `/support` route took over the whole
screen, leaving nothing on screen for a customer to point at when
describing an error, so it's now a corner bubble + panel opened from
"Chat with Support" in the dashboard sidebar
(`SupportChatNavButton.tsx`) or its own always-visible bubble, both
driven by shared state (`SupportChatContext.tsx`, same
provider/context shape as `ToastContext`/`DocumentFocusContext`).
`/support` itself is now just a redirect to `/dashboard`, kept only so
an old bookmark doesn't 404.

Backed by a dedicated JSON endpoint,
[`/api/support/messages`](src/app/api/support/messages/route.ts)
(GET list, POST send), which the widget polls every 4s while open —
**not** `router.refresh()` (the original page's approach), which would
re-fetch the entire host page's data (the dashboard's full invoice list,
most often) on every poll tick just to check for a new chat message.
Messages from a platform admin (`isPlatformAdmin`, checked against the
author's email via the admin API) get a small green "Support" badge so a
customer can tell the vendor's reply from their own teammates' messages
in the same thread.

**Update:** platform admins no longer reach a customer's thread by joining
their org. `/admin/organizations` still shows a message count +
last-message date per org (read via the service-role client, no
membership needed for that), but its "Support chat" button now links out
to the separate Ufirst Ops app's `/support/{orgId}` page instead of
running `joinOrganizationAction` — see
[Ufirst Ops](#ufirst-ops-separate-internal-app) below for why, and only
appears when `OPS_APP_URL` is set. The "View"/"Join as support" button
(full workspace access for troubleshooting) still works the old way —
this change only affects support chat.

---

## Ufirst Ops (separate internal app)

A second, genuinely separate Next.js app (its own repo/deployment, not
yet created) for Ufirst's own internal use — connects to this **same**
Supabase project via the service-role key. Not built for customers to see
or use. Three things drove it:

1. Answering a customer's support message used to require the platform
   admin to actually join that customer's org as a member first. Nobody
   wants to be a member/admin on every client's org just to reply to a
   chat message.
2. Zero visibility into what each customer costs to run — OpenRouter is
   called on every document with no token/cost tracking.
3. A place to roll a feature out to one customer at a time (or kill it
   globally), with every open browser tab finding out it should refresh.

This repo only owns the schema those needs share (migration 0077,
`0077_ops_dashboard.sql`) and a few small hooks in the main app; the Ops
app's own pages (support inbox, customer/cost dashboards, flag CRUD) live
in that separate codebase once it exists.

**Schema (migration 0077):**
- `llm_usage_events` — one row per OpenRouter call (`extract` or
  `classify`), with `prompt_tokens`/`completion_tokens`/`total_tokens`
  and `cost_usd` (populated because both call sites now send
  `"usage": {"include": true}` in the OpenRouter request body — without
  it you only get token counts, no dollar figure). Recorded best-effort
  by [`recordLlmUsage`](src/lib/llm-usage.ts) via the service-role
  client from [`extractInvoiceFields`](src/lib/extract-invoice.ts) and
  [`classifyMultiPageInvoice`](src/lib/invoice-split.ts). No RLS select
  policy for the authenticated role — this is Ufirst's own COGS data,
  not customer-facing, and no historical backfill is possible (tracking
  starts from when this shipped).
- `feature_flags` (`key`, `global_enabled`) + `feature_flag_overrides`
  (`flag_key`, `organization_id`, `enabled`) — a global default per flag
  with optional per-org overrides. [`isFeatureEnabled`](src/lib/feature-flags.ts)
  checks the org override first, falls back to the global default,
  defaults `false` for an unknown key. Nothing in the main app checks a
  flag yet — this just makes the mechanism available for the next
  feature that needs staged rollout.
- `platform_config` — single-row `config_version` counter, bumped by a
  trigger on `feature_flags`/`feature_flag_overrides` any time either
  changes. [`GET /api/platform-config`](src/app/api/platform-config/route.ts)
  exposes it; [`UpdateAvailableBanner`](src/components/UpdateAvailableBanner.tsx)
  (mounted in the dashboard layout) polls it every 60s the same way
  `SupportChatWidget` polls its messages endpoint, and shows a "Refresh"
  bar the moment the version it loaded with no longer matches — this is
  the "notify the browser to refresh" mechanism, and it fires for any
  flag change, not just a specific feature.
- `support_thread_state` (`organization_id`, `last_read_at`) — lets the
  Ops inbox mark which customers have unread messages since Ufirst last
  opened their thread. Written only by Ops.

**Not built yet:** the Ops app itself (new repo, new Vercel project,
sign-in gated by the same `PLATFORM_ADMIN_EMAILS` check as
`/admin/organizations`, pages for the support inbox / customer &
revenue table / OpenRouter cost breakdown / flag management). Creating
that new repo and deployment is a deliberate next step, not done
silently alongside the schema work above.

---

## Settings

`/settings` (member management is admin-only; everyone can edit their own
name/photo). Sections (My profile / Security / Integrations / Invoice
email / Billing & usage / Members) show one at a time — the pill nav at
the top is a real tab switcher (pure CSS `:target`, no client JS), not a
jump-to-anchor list; see [Session log —
2026-08-31](#session-log--2026-08-31-dashboard-rewrite-goes-client-cached-scroll-prefetch-settings-navigation-fixes):
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
filters — status, vendor contains, project, amount range, **total tax
range**, date range, **waiting for** / **approved by** (specific
approvers), and **requester** (who submitted it) — runs against whatever
invoices RLS already lets the caller see, so an admin sees org-wide
totals and a `user` sees their own scope; no extra filtering code needed
for that, every report query already goes through the RLS-bound request
client. Configs can be saved (`saved_reports`) for reuse — e.g. a report
named after one PM, filtered to what's currently sitting with them,
mirroring ApprovalMax's own named-report convention.

The filter set was picked by comparing against a real ApprovalMax report-
edit screenshot: added Approved by / Requester since they were cheap
(data Flow already tracks) and clearly useful. Total tax range was also
added, then removed after trying it — not everything shown in a
reference screenshot earns a permanent spot; also skipped Category,
Class, Currency, and Decision-date from ApprovalMax's own set — each
needs more plumbing (line-item matching, or a second date source) than
what shipped. "Waiting for" and "Approved by" aren't plain invoice
columns: "Waiting for" needs the same per-invoice workflow-step
resolution as the invoice-list report's own column below
(`computeWaitingForIds`,
[`src/lib/workflow-waiting.ts`](src/lib/workflow-waiting.ts)); "Approved
by" is a plain `invoice_approvals` join (`computeApprovedByIds`, now in
`reports.ts` itself, shared by `runReport` and `buildInvoiceListReport` —
the latter used to compute this inline, duplicating the same query).

**Project / Waiting for / Approved by / Requester are searchable
(`FilterCombobox`), not plain `<select>`s** — a project list can run into
the hundreds, where a native dropdown's scroll becomes unusable. This is
the standard going forward for any dropdown with a large option set, not
specific to Reports. `FilterCombobox`
([`src/components/FilterCombobox.tsx`](src/components/FilterCombobox.tsx))
wraps the existing `Combobox` (built for the Bill panel's autosave
fields, which require an `onCommit` callback) with a no-op — **a Server
Component can't pass a plain inline function to a Client Component prop**
(functions aren't serializable across that boundary; React throws
"Functions cannot be passed directly to Client Components" at render
time, not caught by `tsc`/`eslint`/`next build`, so this shipped clean
and only surfaced as a bare-digest 500 in production). `FilterCombobox`
is itself a client component that defines the no-op one hop closer to
the browser, so the Reports page (a Server Component) never touches a
function prop directly. An "Any" pseudo-option in each field's list
handles clearing back to no filter, since `Combobox` reverts to the last
real pick on empty text rather than clearing (correct for its own
always-has-a-value autosave fields, not naturally "clearable").

**Saved reports are a card grid, and actually editable.** Each card
names its own filters in plain English ("Status is On approval",
"Waiting for Bianca") via `describeReportConfig()` — mirrors
ApprovalMax's own "Request reports" screen, which shows the same kind of
filter-chip summary per report. **The whole card is clickable**, not just
the title text — its padding lives on the `Link` itself rather than the
outer card `div`, so there's no dead whitespace around the title that
looks clickable but isn't; Edit and Delete sit in their own footer row
below (a shared flex row with matching line-height, so they stay on one
baseline rather than drifting based on each element's own default box
model). Clicking the card body runs the report (`/reports?run=<id>`).
**Edit** loads the saved config back into the builder form
(`/reports?edit=<id>`) and `saveReport()` updates that row in place
instead of always inserting a new one — previously the only option was
Delete, so a mistake or a filter tweak meant rebuilding the report from
scratch. (`saved_reports` already had a working "members can update" RLS
policy from migration 0010 — verified before relying on it, given this
app's history of silent RLS-gap no-ops elsewhere.)

**Visible columns** — a checkbox picker in the builder (`ReportConfig.columns`,
`REPORT_COLUMNS`/`DEFAULT_REPORT_COLUMNS` in
[`src/lib/invoice-list-report.ts`](src/lib/invoice-list-report.ts)) controls
which columns the invoice list (and its CSV) show, beyond Name (always
shown — it's the link to the invoice). This was in the same ApprovalMax
reference screenshots as the filters above but wasn't built in the first
pass; added after the user pointed out a whole feature had been skipped
despite being clearly visible in what was shared — the lesson being to
proactively pull every good idea out of a reference screenshot, not just
the one filter mentioned in the same message. Two new columns beyond the
original fixed set: **Age** (days since `created_at`) and **Time in
queue** (days on the current step, via `current_step_entered_at` from
migration 0073 — only meaningful while `on_approval`/`on_hold`; a
different status has no one left to be "queued" with, or hasn't entered
the approval workflow yet). Both computed in `buildInvoiceListReport`
regardless of which columns are selected. A report saved before this
feature existed (`config.columns` undefined) falls back to
`DEFAULT_REPORT_COLUMNS` — the exact set that always showed before, so
nothing already-saved changes appearance.

**Invoice list report** ([`src/lib/invoice-list-report.ts`](src/lib/invoice-list-report.ts)):
modeled on ApprovalMax's "Request reports" — one row per invoice (Name,
Amount, Supplier, Status, Approved by, Waiting for, Created, Customers),
not a grouped count/sum, sorted by customer then supplier. The Name column
links straight to the invoice. Shown under any running saved report
(same filters, reuses `filterInvoicesForReport` — factored out of
`runReport` so the two views can't drift onto different filter
semantics). "Waiting for" reuses `requiredApproversFor`
(dashboard-actions.ts) directly, so it matches EXACTLY who'd see Approve/
Reject on the invoice itself — not a second, possibly-drifting
re-derivation of the same matching rules.

**Three downloads**, all scoped to the running report's exact result set
(same RLS-based visibility as everything else) — **only shown once a
report is actually running**, not as a page-level action; an earlier
version had a standalone "Download all invoices (CSV)" link at the top of
`/reports` outside any report, removed since CSV export should only ever
be a per-report download:
- **Download CSV** (`GET /api/reports/export`, same query params as the
  saved-report filters, plus `cols=` for which columns —
  `invoiceListToCsv`'s second argument).
- **Download invoices (PDF)** — reuses the existing
  `/api/invoices/batch-export?ids=...` (`buildMergedInvoicePdf`): every
  matching invoice's original document(s), merged into one PDF.
- **Download audit reports (PDF)** — `GET /api/reports/audit-export`
  (`buildBatchAuditDocument`, [`src/lib/invoice-export.ts`](src/lib/invoice-export.ts)):
  every matching invoice's audit-trail PDF, merged into one PDF.
  Deliberately **audit-only, not paired with the original documents** —
  an earlier version bundled both into one file, but ApprovalMax's own
  screen offers these as two separate archive downloads ("audit reports
  archive" vs "attachment archive"), not one combined bundle, so this
  matches that instead.

---

## Deploying

1. Push this repo to GitHub, import it in Vercel.
2. Add the same env vars from `.env.local` in Vercel's Project Settings → Environment Variables (production values — a separate Supabase project from your local/dev one is strongly recommended).
3. Point the Resend Receiving webhook URL at your production domain.
4. Update `INBOUND_EMAIL_DOMAIN` to match whatever subdomain's MX you actually configure for production.

---

## What's not built yet

This is groundwork, not a finished product. In priority-ish order:

- **No typing indicators** in the Discussion thread — new comments now
  push to every open tab in real time (migration 0091 — see [session log
  — 2026-08-29 to 2026-08-30](#session-log--2026-08-29-to-2026-08-30)),
  but there's no "someone is typing…" signal.
- **Visual polish** — functional Tailwind, not a designed product, outside
  the Bill panel's document-style pass and the shared shell/Dashboard/
  Settings passes (see the 2026-08-31 session log).
- **Auto-sync on approval** — bills reach QBO Ready automatically; the
  final push to QBO is still a manual admin button per bill (no queue /
  scheduled auto-sync yet). This is also a deliberate hard rule, not just a
  gap: nothing reaches QBO until an admin presses the final button.
- **`resolveSupplier`'s find-or-create has no admin UI or merge
  tooling** (see [Session log — 2026-08-30](#session-log--2026-08-30-supplier-entity--admin-mfa-reset)
  for the Supplier entity itself, which IS built). It can create an
  invisible permanent supplier row as a side effect of a read-only
  matching path — worth a look if supplier data quality becomes a
  visible problem.
- **Error/uptime monitoring and signup CAPTCHA are wired but inactive.**
  Sentry (`sentry.*.config.ts`, `src/instrumentation.ts`) and Cloudflare
  Turnstile (`TurnstileWidget.tsx`) are both fully coded as no-ops until
  external accounts are created and their keys are set —
  `NEXT_PUBLIC_SENTRY_DSN` and `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
  respectively (see [Environment variables](#environment-variables)).
  Neither needs more code, just those two accounts.

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

### Per-line Contract / Change Order / Extras tags (CON / CO / E)

Every line item in the Bill panel has a **CON / CO / E toggle** next to the
class search box:

- **CON** writes the QBO class **"Contract"** — the line is original
  contract value.
- **CO** writes the QBO class **"Change Orders"** — the line is extra work
  beyond the contract.
- **E** writes the QBO class **"Extras"** — the line is outside both the
  contract and change orders. Added 2026-08-27 as a third toggle button
  alongside CON/CO (previously "Extras" was just typed into the class
  search box like any other class) — see [BillPanel.tsx](src/components/BillPanel.tsx)'s
  `EXTRAS_CLASS_NAME`. This is a per-line tag, not the old invoice-level
  CO/Extras flag — that stays removed (see below).
- The search box still sets any other class (HB, Chargeback, …).

The toggle writes the line's `class`, which syncs to QBO as that line's
`ClassRef` — so the construction fold app can read each line's class back
out of QBO and tell contract value from change orders from extras (e.g. one
line $50,000 = CON, the next $10,000 = CO, both electrical). Class is a
human decision: it **never** comes from the document, and re-extraction
preserves it (like project) instead of reverting it. If a supplier-default
rule sets a class, it applies to lines with no class yet.

The Class column was widened (118px → 176px) alongside adding the third
button — it also fixes the committed class value truncating to "Chang…"
instead of showing "Change Orders" once idle.

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

### Payment status (migration 0079)

A synced bill's own header (Bill date / Due date / Bill number /
Documents) gains a **Payment status** field once it's actually in QBO —
Paid (with the date) or Unpaid. QuickBooks doesn't put this on the Bill
directly: a Bill's `Balance` field says paid (`0`) vs unpaid, but the
*date* paid only exists on a separate `BillPayment` record, correlated
back via its `Line[].LinkedTxn[]`. [`runQboPaymentSync`](src/lib/qbo.ts)
does both batched reads and is shared by two callers:

- **Nightly at 2am** ([`/api/cron/qbo-payment-sync`](src/app/api/cron/qbo-payment-sync/route.ts),
  `vercel.json`'s `"0 6 * * *"` — Vercel Cron runs in UTC with no DST
  adjustment, so this drifts to 1am Eastern once EST resumes)
  across every org with a QBO connection.
- **On demand**: a "Sync payment status from QuickBooks" button in
  Settings (`syncQboPaymentStatus` in dashboard-actions.ts), admin-only,
  logged to `qbo_sync_log` like the other mirrors.

Only re-checks bills that aren't already confirmed paid
(`qbo_payment_status IS NULL OR = 'unpaid'`) — a naturally shrinking set
that never re-queries a bill once it's marked paid. Undoing a sync
(`clearQboSync`) also clears the payment fields, since there's no longer
a valid bill to check against.

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
