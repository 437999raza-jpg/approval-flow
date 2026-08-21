# Approval Flow

Invoice approval workflows (ApprovalMax-style), built on Next.js, deployed on
Vercel, with Supabase for Postgres, Auth, and Storage, and an OpenRouter
model for invoice field extraction.

Status: **early-stage groundwork**, not a finished product. Auth, invoice
ingestion (manual + email), a rules-based routing engine, role-scoped
visibility, a review queue, per-supplier default rules, and a master-detail
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
| Email ingestion | SendGrid Inbound Parse (webhook) | Forwards email attachments to our API as multipart form data |

---

## How it fits together

```
                    ┌─────────────────────┐
  "Add invoice" ───▶│ /api/invoices/upload│──┐
  (dropzone, UI)     └─────────────────────┘  │
                                                ▼
                                     createInvoiceFromFile()
                                     (src/lib/invoices.ts)
                                                │  ├─ upload file → Supabase Storage
  Forwarded email ─▶┌──────────────────────┐   │  ├─ extractInvoiceFields() → OpenRouter
  (SendGrid parse)   │/api/webhooks/        │──┘  ├─ apply supplier_defaults, if matched
                      │inbound-email        │      ├─ route → selectWorkflowForInvoice()
                      └──────────────────────┘      ├─ insert `invoices` row (status: on_review)
                                                      └─ insert `audit_log` row
                                                │
                                                ▼
                              Supabase Postgres (RLS-scoped by org + role)
                                                │
                                                ▼
                          /dashboard/[[...id]]  (master-detail UI)
              Review Complete (admin) → re-routes → Approve/Reject/Hold/Cancel
                          → invoice_approvals + audit_log
```

Both ingestion paths — the "Add invoice" button/dropzone and the inbound
email webhook — funnel through the single `createInvoiceFromFile()` function
in [`src/lib/invoices.ts`](src/lib/invoices.ts), so they get identical
validation, storage, field extraction, supplier-default overrides, and audit
logging. Every new invoice lands in `on_review` — an admin has to run
Review Complete before it's actually routed into an approval workflow (see
[Invoice lifecycle](#invoice-lifecycle--statuses)).

---

## Data model

Full schema: [`supabase/migrations/`](supabase/migrations/) (20 migrations,
`0001` → `0020`; see [Migration history](#migration-history) for what each
one added).

| Table | Purpose |
|---|---|
| `organizations` | One row per tenant. Has a unique `inbound_email_token` — the local-part of that org's inbound invoice email address. |
| `organization_members` | Join table: user ↔ org, with a `role` — `admin` / `auditor` / `user` (see [Roles](#roles--permissions)). |
| `profiles` | Mirrors `auth.users` (display name + `avatar_url`) so app tables can join without touching the `auth` schema. |
| `projects` | Org-scoped customers/jobs/classes. `qbo_id` is reserved for QuickBooks sync. Manually entered today. |
| `approval_workflows` | Named workflow per org; one is flagged `is_default`. |
| `approval_workflow_steps` | Ordered approval chain per workflow — `step_order` + `approver_user_id`. |
| `approval_workflow_rules` | Routing conditions per workflow (amount/requester/supplier/customer/category/class/product) — see [Workflow routing](#workflow-routing--rules). |
| `approval_workflow_projects` | Links a project to the workflow that manages access to it (see [Projects & visibility](#projects--visibility)). |
| `supplier_defaults` | Per-supplier default rules (Category/Class/Project/Tax rate/Payment terms/Currency), matched by normalized vendor name — see [Supplier default rules](#supplier-default-rules). |
| `invoices` | The core record. `status`: one of 6 values, see [Invoice lifecycle](#invoice-lifecycle--statuses). `source`: `manual`/`email`. Holds both the mapped extracted fields and the full raw `extraction` JSON. `step_override_approver_id` is an admin's per-invoice reassignment (see [Admin overrides](#admin-overrides)). |
| `invoice_line_items` | Category-details rows (Category/Description/Tax rate/Class/**Project**/Amount/Linked) — a bill can split across multiple projects, one per line. |
| `invoice_documents` | Extra pages beyond the primary file (multi-document support). |
| `invoice_approvals` | One row per approve/reject decision, keyed by `invoice_id` + `step_order`, unique-constrained so double-decisions are impossible even under a race. |
| `invoice_comments` | Discussion thread per invoice. |
| `saved_reports` | Saved report configs (metric/group-by/filters) for the [Reports](#reports) page. |
| `audit_log` | Append-only activity trail per org/invoice. |
| `inbound_email_log` | Raw record of every inbound-email webhook hit, matched or not — the debugging trail for email ingestion. |

**Row Level Security** is enabled on every table. Visibility is enforced by
two SECURITY DEFINER functions: `is_org_member`/`is_org_admin`/
`is_org_auditor` (role checks) and `can_see_invoice(inv_id)` (the actual
per-invoice visibility rule — see [Projects &
visibility](#projects--visibility)). The inbound-email webhook has no
logged-in user, so it uses the Supabase **service role** key
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

---

## Environment variables

Copy `.env.example` → `.env.local` and fill in:

| Variable | Required | Where it comes from |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Same page → **Publishable key** (new naming) / anon key (legacy naming) — safe to expose client-side |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Same page → **Secret key** (new naming) / service_role key (legacy) — **server-only, full admin access, never expose to the client** |
| `INBOUND_EMAIL_WEBHOOK_SECRET` | Yes (for email ingestion) | Any random string you choose; appended as `?token=` on the webhook URL you give SendGrid |
| `INBOUND_EMAIL_DOMAIN` | Yes (for email ingestion) | A subdomain you control, e.g. `invoices.yourapp.com` |
| `OPENROUTER_API_KEY` | For extraction | openrouter.ai — required for invoice field/line-item extraction (without it, extraction silently no-ops rather than failing ingestion) |
| `OPENROUTER_MODEL` | No | Any OpenRouter model id, e.g. `anthropic/claude-sonnet-4.5`, `openai/gpt-4o`, `google/gemini-2.0-flash-001` — defaults to `anthropic/claude-sonnet-4.5`. This is the knob for testing extraction quality across models. |

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
2. **Run all 20 migrations**, in order — paste each file in
   [`supabase/migrations/`](supabase/migrations/) into the SQL editor and
   run it (`0001` through `0020`), or `supabase db push` if you have the CLI
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
matters because Supabase magic-link/password redirects, and the SendGrid
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

insert into approval_workflow_steps (workflow_id, step_order, approver_user_id)
  values ('<workflow id above>', 1, '<your auth.users id>');
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
| `user` | Invoices they submitted, project-less invoices, and invoices whose project is covered by a workflow they're an approver on (see [Projects & visibility](#projects--visibility)) | Submit invoices, act as an approver on steps assigned to them, comment |

`user` never sees invoices still in `on_review` (Review Complete is
admin-only) — enforced by `can_see_invoice()` at the database level, not
just hidden in the UI.

---

## Invoice lifecycle & statuses

Six statuses (migration 0017), matching ApprovalMax's own set:

```
        Review Complete (admin)
on_review ─────────────────────▶ on_approval ──approve (final step)──▶ approved
   │                                 │  ▲
   │                                 │  └── Hold ──▶ on_hold ──Back to Review──▶ on_review
   │                                 │
   │                                 └── reject ──▶ rejected
   │
   └── Cancel (submitter or admin, from on_review/on_approval/on_hold) ──▶ cancelled
```

- **`on_review`** — every new invoice lands here regardless of source. An
  admin fixes up extracted fields, then clicks **Review Complete**, which
  re-runs [workflow routing](#workflow-routing--rules) (project/line items
  may now be known) and moves it to `on_approval` at step 1.
- **`on_approval`** — waiting on whoever's assigned to `current_step_order`
  ([admins can reassign](#admin-overrides)). Approve advances to the next
  step or, on the final step, to `approved`. Reject goes straight to
  `rejected`.
- **`on_hold`** — the current approver paused it instead of deciding;
  **Back to Review** (admin) sends it back to `on_review` at step 1,
  resetting decisions but keeping the audit trail.
- **`approved`** / **`rejected`** — terminal.
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

### Manual upload

UI: [`src/components/InvoiceUploadDropzone.tsx`](src/components/InvoiceUploadDropzone.tsx)
(click or drag-and-drop) on `/invoices/new` → `POST /api/invoices/upload`
(authenticated, uses the signed-in user's session) → `createInvoiceFromFile()`.

### Email ingestion (SendGrid Inbound Parse)

Each org has a unique `inbound_email_token`; mail sent to
`{token}@{INBOUND_EMAIL_DOMAIN}` is attributed to that org. Shown on the
dashboard sidebar.

**Setup:**
1. In SendGrid: Settings → Inbound Parse → Add Host & URL.
2. **Subdomain**: the value of `INBOUND_EMAIL_DOMAIN` (e.g. `invoices.yourapp.com`).
3. Add an MX record for that subdomain pointing to `mx.sendgrid.net` (priority 10), per SendGrid's instructions.
4. **Destination URL**: `https://<your-domain>/api/webhooks/inbound-email?token=<INBOUND_EMAIL_WEBHOOK_SECRET>`.
5. Forwarding/CC'ing an email to an org's inbound address creates one invoice per PDF/image attachment.
6. Every hit (matched or not, invoice created or not) is logged to `inbound_email_log` for debugging.

**Testing the webhook locally without SendGrid** — simulate the POST with curl:

```bash
curl -X POST "http://localhost:3210/api/webhooks/inbound-email?token=<INBOUND_EMAIL_WEBHOOK_SECRET>" \
  -F "to=<org_inbound_token>@<INBOUND_EMAIL_DOMAIN>" \
  -F "from=vendor@supplier.com" \
  -F "subject=Invoice for August services" \
  -F "attachments=1" \
  -F "attachment1=@/path/to/invoice.pdf;type=application/pdf"
```

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
extraction failures resolve to `null` rather than blocking ingestion. A
**"Re-extract document fields"** button in the Bill panel re-runs the
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

`/workflows` (admin-managed, `user`/`auditor` see it read-only):

- Each **workflow** has an ordered list of **approval steps** (who approves,
  in what order) and a list of **workflow items** (routing rules).
- **Routing** ([`src/lib/workflow-routing.ts`](src/lib/workflow-routing.ts)):
  evaluated at Review Complete, in workflow creation order — the **first**
  workflow whose rules **all** match wins; if none match, the org's default
  workflow is used.
- **Rule types**: `total_amount` (any/between/under/over/equal),
  `requester`, `supplier`, `product_service`, `category`, `class`,
  `customer` (any/matches/not_matches). `customer` matches against *every*
  project touched by the invoice's line items (a bill can split across
  several — see [Projects & visibility](#projects--visibility)), not a
  single field.
- A workflow with **no rules** matches every invoice — that's how the
  default workflow is meant to be configured.

---

## Projects & visibility

`projects` (Settings-managed) are org-scoped customers/jobs/classes. Two
separate things depend on them:

1. **Access control** — a `user`-role member can only see an invoice if
   they're an approver on a workflow linked (via `approval_workflow_projects`)
   to a project the invoice touches, or if they submitted it, or if it has
   no project at all. Enforced by `can_see_invoice()` in Postgres, not the
   UI.
2. **Routing** — the `customer` rule type in [workflow
   rules](#workflow-routing--rules).

**A bill can split across multiple projects** (migration 0019): Project is
a field on each **line item** (Category details), not a single
invoice-level field — because a real invoice might have some cost going to
Project A and some to Project B. Visibility and routing both match on *any*
of the projects an invoice's line items touch (deliberately permissive — in
practice a split only ever happens across projects the same PM already
covers).

---

## Supplier default rules

Dext/ApprovalMax-style: a **"Supplier rules"** link on the Bill panel
(next to the vendor name) opens a modal to save defaults for that supplier
— Category, Class, Project/customer, Tax rate, Currency, and Payment terms
(days after invoice date, computes the due date).

- **Matched by normalized vendor name** (trim + lowercase) — there's no
  first-class Supplier entity yet, same matching used for [duplicate
  detection](#document-search) and the Document Search Supplier filter.
- **Applied automatically at ingestion**: every future invoice from that
  vendor picks up the rule the moment it's created (see [Field
  extraction](#field-extraction-openrouter-model-agnostic)) — nothing to
  click per invoice.
- **Prefills from the current invoice**, not a blank form: if no rule
  exists yet for a vendor, opening "Supplier rules" fills in whatever's
  already on that invoice's first line item + currency/dates, so confirming
  a new rule is a one-click "yes, remember this" instead of retyping.
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

**Possible-duplicate detection**: opening an invoice checks (live, not
stored) for another non-cancelled/rejected invoice from the same normalized
vendor with the same invoice number. Shows an orange banner linking to the
match(es); if the amount differs, notes it as a likely price-corrected
resubmission rather than a true duplicate. Purely informational — nothing
is auto-blocked or auto-linked.

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
- **Detail pane**: amount/status header, a possible-duplicate warning if
  relevant, an approval stepper (green = decided, blue = current step, grey
  = upcoming), the Approve/Reject/Hold/Cancel/Review-Complete buttons for
  whichever apply, [admin overrides](#admin-overrides), a discussion
  thread, and an audit-trail PDF download.

**Bill panel** ([`src/components/BillPanel.tsx`](src/components/BillPanel.tsx)):
redesigned to read like an actual invoice document rather than a form —
every field uses a "ghost" style (invisible border at rest, a line appears
on hover/focus) instead of a boxed input, still fully editable in place:
vendor/email, bill date/due date/bill number, total/tax/currency (Subtotal
computed), and a **Category-details table** (Category, Description,
**Project/customer**, Tax %, Class, Amount, Linked) with add/delete rows.
On sync this maps directly to the QBO bill — header fields to the bill,
rows to line items.

**Multi-document support**: an invoice can carry the primary file plus any
number of additional pages (`invoice_documents`). The document viewer gets
a page switcher ("2 / 3") and an **"Add document"** button. On sync,
**everything** attaches to the bill: the audit-trail PDF + all documents
([`src/lib/qbo-attachments.ts`](src/lib/qbo-attachments.ts)).

`/invoices/[id]` still exists as a redirect to `/dashboard/[id]`, in case
anything links to the old URL shape.

---

## Settings

`/settings` (member management is admin-only; everyone can edit their own
name/photo):

- **My profile** — display name, photo upload (`avatars` bucket, 0016).
- **Members** — a real table (avatar, name, email, role, status, 2FA —
  genuinely read from Supabase's enrolled-factors data, not a placeholder),
  search, and an **Add new users** modal (creates the `auth.users` account
  if needed, sets an initial name). Role changes and removal are inline.
- **Approval workflows** — read-only summary here; full management is on
  [`/workflows`](#workflow-routing--rules).
- **Projects / customers** — create/edit/deactivate, and link each one to
  the workflow that manages access to it.

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
3. Point the SendGrid Inbound Parse destination URL at your production domain.
4. Update `INBOUND_EMAIL_DOMAIN` to match whatever subdomain's MX you actually configure for production.

---

## What's not built yet

This is groundwork, not a finished product. In priority-ish order:

- **Org signup/invite flow for the very first admin** — once one admin
  exists, [Settings](#settings) can invite everyone else; bootstrapping
  that first admin is still a manual SQL insert (see [First org
  setup](#first-org-setup)).
- **Accounting system sync** (Xero/QuickBooks/NetSuite) — the other half of
  what makes a tool like ApprovalMax useful; not started. The shape is
  ready for it: [`src/lib/qbo-attachments.ts`](src/lib/qbo-attachments.ts)
  already knows what should attach to the synced bill (audit-trail PDF +
  every invoice document), and the Bill panel's fields map directly to QBO
  bill fields.
- **Real Supplier entity** — supplier defaults, duplicate detection, and
  the Document Search Supplier filter all match on normalized vendor-name
  text rather than a proper linked entity. Works, but fragile if the same
  supplier's name comes through spelled differently across invoices.
- **Reports vs. per-line-item projects** — see the gap noted in
  [Reports](#reports).
- **Real-time chat** — the comment thread is a simple list today; live
  updates (Supabase Realtime), mentions, and typing indicators aren't
  built.
- **Visual polish** — functional Tailwind, not a designed product, outside
  the Bill panel's document-style pass.
- **Rejection detail** — a rejected invoice records the decision but
  there's no UI prompt to capture *why* at reject time.

---

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
