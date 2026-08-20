# Approval Flow

Invoice approval workflows (ApprovalMax-style), built on Next.js, deployed on
Vercel, with Supabase for Postgres, Auth, and Storage, and Claude for
invoice field extraction.

Status: **early-stage groundwork**, not a finished product. Auth, invoice
ingestion (manual + email), approval routing, and a master-detail dashboard
UI are working end to end. See [What's not built yet](#whats-not-built-yet)
for the real gaps.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 14 (App Router), TypeScript | Server components + Route Handlers in one deployable |
| Hosting | Vercel | Pairs naturally with Next.js |
| Database / Auth / Storage | Supabase (Postgres + `@supabase/ssr`) | One backend for data, auth, and file storage; Row Level Security for multi-tenancy |
| Styling | Tailwind CSS | Fast iteration, no component library |
| Invoice field extraction | Claude API (`claude-opus-5`, `@anthropic-ai/sdk`) | Vision/document input to pull vendor/amount/due date from uploaded PDFs/images |
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
  Forwarded email ─▶┌──────────────────────┐   │  ├─ extractInvoiceFields() → Claude API
  (SendGrid parse)   │/api/webhooks/        │──┘  ├─ insert `invoices` row (default workflow)
                      │inbound-email        │      └─ insert `audit_log` row
                      └──────────────────────┘
                                                │
                                                ▼
                              Supabase Postgres (RLS-scoped by org)
                                                │
                                                ▼
                          /dashboard/[[...id]]  (master-detail UI)
                          approve/reject → invoice_approvals + audit_log
```

Both ingestion paths — the "Add invoice" button/dropzone and the inbound
email webhook — funnel through the single `createInvoiceFromFile()` function
in [`src/lib/invoices.ts`](src/lib/invoices.ts), so they get identical
validation, storage, field extraction, default-workflow assignment, and
audit logging. There is no separate code path per source.

---

## Data model

Full schema: [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql).

| Table | Purpose |
|---|---|
| `organizations` | One row per tenant. Has a unique `inbound_email_token` — the local-part of that org's inbound invoice email address. |
| `organization_members` | Join table: user ↔ org, with a `role` (`admin` / `approver` / `submitter`). |
| `profiles` | Mirrors `auth.users` (id + display name) so app tables can join without touching the `auth` schema. |
| `approval_workflows` | Named workflow per org; one is flagged `is_default`. |
| `approval_workflow_steps` | Ordered steps per workflow — `step_order` + the `approver_user_id` responsible for that step. |
| `invoices` | The core record. `status`: `pending → in_review → approved/rejected/paid`. `source`: `manual`/`email`. Extracted fields (`vendor_name`, `invoice_number`, `amount`, `currency`, `due_date`) are nullable. `current_step_order` tracks where it is in its workflow. |
| `invoice_approvals` | One row per approve/reject decision, keyed by `invoice_id` + `step_order`. |
| `invoice_comments` | Discussion thread per invoice (schema exists; no UI yet). |
| `audit_log` | Append-only activity trail per org/invoice. |
| `inbound_email_log` | Raw record of every inbound-email webhook hit, matched or not — the debugging trail for email ingestion. |

**Row Level Security** is enabled on every table, scoped through
`organization_members` via the `is_org_member(org_id)` helper function. The
inbound-email webhook has no logged-in user, so it uses the Supabase
**service role** key ([`src/lib/supabase/admin.ts`](src/lib/supabase/admin.ts)),
which bypasses RLS entirely — treat that key as a full admin credential.

Migration 0002 adds: a **unique `(invoice_id, step_order)` constraint** on
`invoice_approvals` (one decision per step, race-proof), an index for
chronological comment reads, and a **"profiles: org members can read"**
policy so comment authors and approver names can be displayed (viewer and
target must share an org — the "read own" policy still applies to everyone
else).

**Storage**: one private bucket, `invoices`. Files are stored at
`{organization_id}/{uuid}-{filename}`; the storage RLS policies parse the
first path segment as the org id to authorize access.

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
| `ANTHROPIC_API_KEY` | Optional | console.anthropic.com — if unset, invoice field extraction silently no-ops (fields stay null) rather than failing the upload |

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
2. **Run the migrations**: paste [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) **and** [`supabase/migrations/0002_approval_hardening.sql`](supabase/migrations/0002_approval_hardening.sql) into the SQL editor and run them, or `supabase db push` if you have the CLI linked. `0002` is **idempotent** — safe to re-run any number of times.
3. **Create the storage bucket**: Storage → New bucket → name `invoices`, **Public off**. (Or run the commented `insert into storage.buckets` line at the bottom of the migration.)
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
yet](#whats-not-built-yet)). To attach a user to an org:

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
  URL-preview mechanisms before a human clicks them, so treat "email rate
  limit exceeded" as a dev-only annoyance to route around, not a bug to fix.
  `/auth/confirm` has a fallback that treats an already-established session
  as success if the token itself fails, which helps but doesn't fully
  eliminate this.

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

### Field extraction

[`src/lib/extract-invoice.ts`](src/lib/extract-invoice.ts) sends the
uploaded PDF/image to Claude (`claude-opus-5`) as a document/vision content
block, forcing a structured tool call (`strict: true`) to pull
`vendor_name`, `invoice_number`, `amount`, `currency`, `due_date`. Runs in
parallel with the Storage upload inside `createInvoiceFromFile()`. Any
failure (missing `ANTHROPIC_API_KEY`, bad file, API error) resolves to
`null` fields rather than throwing — extraction is best-effort and never
blocks ingestion.

---

## Dashboard UI

`/dashboard/[[...id]]` ([`src/app/dashboard/[[...id]]/page.tsx`](src/app/dashboard/[[...id]]/page.tsx))
is a master-detail interface, all server-rendered:

- **Sidebar**: org name + inbound email address, and nav filters computed
  from real data — All invoices, **Requires my approval** (invoices whose
  current workflow step's `approver_user_id` matches the signed-in user),
  Created by me, Approved, Rejected. Each shows a live count.
- **Search**: `?q=` filters the list by vendor/file name/invoice number.
- **List pane**: clicking a row navigates to `/dashboard/[id]?...` (filters
  preserved in the query string), which server-renders the detail pane.
- **Detail pane** (all server-rendered, everything collapsible):
  - **Sidebar** collapses via a hamburger; **invoice list** and **document
    viewer** collapse to slim strips.
  - **Extracted fields**: a Dext-style grid (Item ID, Document owner, Type,
    Date, Supplier, Document reference, Due date, Amount, Currency, Total
    amount, … — fields without data render "—").
  - **Status & approval**: the stepper (green = decided, blue = current step,
    grey = upcoming) + Approve/Reject Server Actions.
  - **Info** panel with four collapsible sub-panels: **Chat** (discussion
    thread), **Email Details** (from/subject/to/received/file, pulled from
    `inbound_email_log`), **Notes** (free-text, stored on `invoices.notes`),
    and **History** (the raw `audit_log` + audit-PDF download).

**Approval decisions are enforced server-side**: only the approver assigned
to the current step can decide, prior steps must be approved first, and the
unique `(invoice_id, step_order)` constraint in migration 0002 makes double
decisions impossible. The buttons only render for the current approver;
anyone else sees "Waiting on the approver for step N." Failures redirect to
`?error=...` and are shown as a banner in the detail pane.

**Chat / discussion**: org members can post and read comments on each
invoice (stored in `invoice_comments`, authored by the signed-in user).
This is deliberately a simple thread today; a real-time chat window can be
layered on top by subscribing to `invoice_comments` with Supabase Realtime.

**Audit trail document**: `/api/invoices/[id]/audit-trail`
([`src/lib/audit-trail.ts`](src/lib/audit-trail.ts)) generates a **PDF**
(dependency-free writer in [`src/lib/pdf.ts`](src/lib/pdf.ts)) combining the
invoice metadata, the full approval trail, the chat history, and the raw
`audit_log` — served as a downloadable attachment. This is one of the two
files attached to the QBO bill on sync; the exact two-file bundle is
assembled by [`src/lib/qbo-attachments.ts`](src/lib/qbo-attachments.ts):

1. **`audit-trail-<vendor>-<id>.pdf`** — chat history + approval audit trail (one PDF)
2. **the original invoice document** — the invoice PDF/image as uploaded

`/invoices/[id]` still exists as a redirect to `/dashboard/[id]`, in case
anything links to the old URL shape.

---

## Deploying

1. Push this repo to GitHub, import it in Vercel.
2. Add the same env vars from `.env.local` in Vercel's Project Settings → Environment Variables (production values — a separate Supabase project from your local/dev one is strongly recommended).
3. Point the SendGrid Inbound Parse destination URL at your production domain.
4. Update `INBOUND_EMAIL_DOMAIN` to match whatever subdomain's MX you actually configure for production.

---

## What's not built yet

This is groundwork, not a finished product. In priority-ish order:

- **Org signup/invite flow** — currently: manual SQL insert (see [First org setup](#first-org-setup)). No UI to create an org, invite teammates, or assign roles.
- **Multi-step / conditional approval workflows** — the schema supports ordered steps and multiple workflows per org, but nothing in the UI creates a second workflow, routes by amount threshold, or routes by vendor. Every invoice currently goes through the single default workflow.
- **Accounting system sync** (Xero/QuickBooks/NetSuite) — the other half of what makes a tool like ApprovalMax useful; not started. When QBO sync lands, the bill gets **two attachments**: the [audit-trail PDF](#dashboard-ui) (chat history + approval audit trail) and the original invoice document ([`src/lib/qbo-attachments.ts`](src/lib/qbo-attachments.ts)).
- **Real-time chat window** — a basic comment thread exists on each invoice; the full chat experience (live updates, mentions, typing indicators) is not built.
- **Visual polish** — functional Tailwind, not a designed product.
- **Rejection detail** — a rejected invoice records the decision but there's no UI to see *why* (no comment prompt on reject).

---

## Product direction

Approval Flow is being built as a **multi-tenant SaaS for multiple paying
customers** — one Supabase project, many orgs, isolated by RLS. The
end-to-end vision:

1. Invoices and receipts come in however the customer likes (upload, email,
   later: mobile photo capture).
2. Field extraction (Claude) pulls vendor/amount/due date.
3. Approval routing pushes the invoice through the customer's workflow.
4. Authorized people **chat about the invoice** in a full chat window —
   the discussion thread here is the foundation for it.
5. On approval, the invoice syncs to the customer's accounting system
   (Xero / QuickBooks) as a bill with **two attachments**: the
   **audit-trail PDF** (chat history + approval audit trail, one file) and
   the **original invoice PDF** ([`src/lib/qbo-attachments.ts`](src/lib/qbo-attachments.ts)).

A production domain/brand is coming; `INBOUND_EMAIL_DOMAIN` and the org
inbound addresses already flow from env vars, so rebranding is config, not
code.

---

## Known limitations worth knowing about

- **No tests.** Everything so far has been verified by hand (manual upload, email webhook via curl, approve/reject flow) in a live Supabase project — see the [Authentication](#authentication) section for the local sign-in gotchas encountered along the way.
- **Single-user workflows in practice**: with one org member, "requires my approval" and "created by me" will often show the same invoices — the filters are correct, there just isn't more than one person to exercise them against yet.
- **`paid` status** exists in the schema but is currently write-only from SQL — no app code touches it (it will become meaningful once accounting sync lands).

---

*Authored by Araza.*
