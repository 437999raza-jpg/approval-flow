# DEPLOY.md — from local to live on flow.ufirst.co (plain-language guide)

This guide takes the app from running on your laptop to a live, customer-ready
URL: **https://flow.ufirst.co** — with inbound email, QuickBooks, and billing
all connected. You are not a coder; every step below is click-and-paste.
Nothing here requires writing code.

**Time to complete (first time):** roughly 1–2 hours, mostly waiting on
verifications.

---

## 0. What you need (accounts)

| Service | Purpose | Do you have it? |
|---|---|---|
| GitHub | Hosts the code (Vercel deploys from it) | ❌ create one (free) |
| Vercel | Hosts the app (free tier is fine to start) | ❌ create one (free) |
| Supabase | Database + auth + storage | ❌ create a NEW project (free tier fine) |
| Cloudflare | Your DNS for `ufirst.co` | ✅ you have it |
| Resend | Sends emails (@mentions, invites) | ✅ you set it up |
| SendGrid | Receives invoice emails (inbound) | ❌ create one (free tier fine) |
| Intuit Developer | The QBO connection | ❌ create one (free) |
| OpenRouter | Invoice extraction | ✅ you have the key |

> **You asked: use the free tiers.** Every service below has a free tier and
> at your expected volume (one company, a handful of invoices a day) the
> whole stack runs on **$0/month plus OpenRouter usage** (a few pennies per
> invoice). The only cost that will ever matter is the customer's QBO
> subscription, which they already pay for.

---

## 1. Push the code to GitHub

1. Create a free account at github.com (username, e.g. `araza`).
2. Click **New repository** → name it `approval-flow` → **Public or Private**
   (either is fine) → **Create repository**.
3. In your project folder on the Mac, open **Terminal** and run (this is the
   only command you'll run — copy-paste, then Enter):

   ```bash
   cd ~/Documents/Deepseek_Harness/Approval_Flow
   git remote add origin https://github.com/<YOUR-USERNAME>/approval-flow.git
   git push -u origin main
   ```

   (You'll be asked to sign in to GitHub in the browser — that's normal.)

---

## 2. Create the production Supabase project

1. Go to supabase.com → **New project** → name it `approval-flow-prod` →
   choose a region (closest to Toronto: **North America (Central)** or
   **us-east-1**) → set a strong database password → **Create new project**.
2. Wait for it to finish (a minute or two).
3. Open **SQL Editor** → paste the ENTIRE contents of
   `supabase/full_schema.sql` (in your project folder) → **Run**.
   - This creates everything (tables, security, storage rules).
4. Create the storage bucket:
   - Left sidebar → **Storage** → **New bucket** → name: `invoices` →
     **Public: off** → Create.
   - Repeat for bucket `avatars` → **Public: on**.
5. Copy your keys (you'll paste them into Vercel in step 4):
   - **Project Settings → API** → copy **Project URL**, **Publishable key**,
     and **Secret key** (the secret is server-only — never share it).
6. **(Optional but recommended)** Set a password for your login:
   - **Authentication → Users** → find your email → **…** → **Send password
     reset** — or just use the magic link flow.

> Your **.env.local** on the Mac keeps pointing at the OLD test project.
> That's fine — the live site uses its own (prod) project.

---

## 3. Connect Vercel to GitHub and deploy

1. Go to vercel.com → sign in with GitHub → **Add New → Project** →
   choose the `approval-flow` repo → **Import**.
2. In the **Environment Variables** screen, add every line from
   `.env.production.example` in your project folder, replacing `<...>`
   placeholders with your real values:
   - Supabase URL / publishable / secret (from step 2.5)
   - `INBOUND_EMAIL_DOMAIN=invoices.ufirst.co`
   - `INBOUND_EMAIL_WEBHOOK_SECRET` = a long random string (make one up,
     e.g. `wf-9f8e7d6c5b4a...`)
   - `OPENROUTER_API_KEY` (you have it)
   - `RESEND_API_KEY` + `RESEND_FROM_EMAIL` (from Resend; use a sender
     address on a domain you control, e.g. `noreply@ufirst.co` — you must
     verify that domain in Resend first)
   - `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` (from Intuit — step 6)
   - `QBO_REDIRECT_URI=https://flow.ufirst.co/api/qbo/callback`
   - `BILLING_RATE_PER_INVOICE=5.00` (your price per invoice)
3. Click **Deploy**. First deploy takes a few minutes.
4. When done, Vercel gives you a URL like `approval-flow.vercel.app` — open
   it; you should see the login page. **Congrats — the app is live.**
5. Add your custom domain: **Project → Settings → Domains → Add** →
   `flow.ufirst.co`.

---

## 4. Point the domain (Cloudflare + Vercel)

1. In **Vercel → Settings → Domains**, after adding `flow.ufirst.co`, Vercel
   shows you the DNS record to create (a **CNAME**).
2. In **Cloudflare** (dash.cloudflare.com → your `ufirst.co` site → **DNS →
   Records**):
   - Add the **CNAME** from step 1 (e.g. name `flow`, target
     `<something>.cname.vercel-dns.com`, proxy **OFF** or grey-cloud for
     Vercel-managed TLS).
3. Wait a few minutes; Vercel will show the domain as **Valid Configuration**.
   `https://flow.ufirst.co` now serves the app.

---

## 5. Inbound invoice email (SendGrid)

You want invoices emailed to the app to become invoices. The address will be
`{org-token}@invoices.ufirst.co`.

1. In **Cloudflare → DNS → Records** for `ufirst.co`, add:
   - Type **MX**, name `invoices`, mail server `mx.sendgrid.net`, priority
     `10`.
2. Create a **SendGrid** account → verify `ufirst.co` (they'll have you add a
   TXT record in Cloudflare — follow their prompt).
3. In SendGrid: **Settings → Inbound Parse → Add Host & URL**:
   - Domain: `invoices.ufirst.co`
   - URL: `https://flow.ufirst.co/api/webhooks/inbound-email?token=<INBOUND_EMAIL_WEBHOOK_SECRET>` (same secret as Vercel)
   - **Save**.
4. Test: email a PDF to the org's inbound address (shown in the app sidebar)
   — it should appear as an invoice.

---

## 6. QuickBooks Online (Intuit)

1. Go to developer.intuit.com → sign up → **Create an app** (name it
   `Approval Flow`; you'll be asked to pick accounting software — choose
   QuickBooks Online).
2. In the app: **Development → Settings**:
   - Redirect URI: `https://flow.ufirst.co/api/qbo/callback` (add it;
     also add `http://localhost:3210/api/qbo/callback` if you want local
     testing too).
   - **Users**: add the email address that is **admin of the company's QBO**
     (the fluidconstruction.ca admin). This is what allows a real (non-
     sandbox) company to connect.
3. Copy **Client ID** and **Client Secret** → paste into Vercel env vars
   (`QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`).
4. In the app: **Settings → Integrations → Connect QuickBooks** → sign in
   with the fluidconstruction.ca admin → authorize.
5. **Test carefully** — this creates REAL bills in the real QBO company.
   Sync one small invoice first, check the bill + attachments in QBO, then
   go.

> For selling to other customers later, you'll request Intuit **production
> access** (a short review). Not needed while it's just your company.

---

## 7. Your first real use

1. Log in at **https://flow.ufirst.co** as yourself.
2. **Settings → Members** → invite the fluidconstruction.ca team (roles:
   User / Auditor).
3. **Workflows** → make sure a workflow exists with steps → assign approvers.
4. **Settings → Integrations** → connect QuickBooks (step 6.4).
5. **Settings → Billing & usage** → see the monthly count + suggested charge
   so you can bill Fluid Construction.
6. Upload/email an invoice → it lands in **Pending Review** → Review Complete
   → approvers Approve → **Sync to QuickBooks** → verify in QBO.

---

## 8. Keeping it alive (updates, backups, costs)

- **Deploying changes**: when you or I change the code, push to GitHub and
  Vercel redeploys automatically.
- **Database backups**: Supabase → Project Settings → Database → **PITR /
  Backups** (free tier has daily backups).
- **Costs: free tiers, as you asked.** Vercel **Hobby** (free) — plenty
  for this volume; Supabase **Free** (500 MB DB, 1 GB storage — fine);
  SendGrid **free** (100 emails/day — inbound invoices count toward it, so
  keep under ~100 inbound emails/day); Resend **free** (3,000
  emails/month); Cloudflare **free**; Intuit **free** to connect (QBO itself
  is the customer's subscription); **OpenRouter is the only pay-as-you-go**
  (roughly pennies per invoice extracted).
- **Free-tier gotchas to know**:
  - **Supabase Free pauses the project after 1 week of no activity.** With
    daily use you'll never notice; if it pauses, just log into Supabase and
    it resumes (or click "Restore").
  - **Vercel Hobby** has no custom "serverless function regions" and caps
    configurable function duration at **60s**. The extraction and QBO sync
    routes already declare `maxDuration = 60` (and Node 20 is pinned in
    `package.json`), so invoice processing won't time out. A very slow
    extraction day could still hit the cap — just press Re-extract / Sync
    again; it's safe to retry.
  - **SendGrid free = 100 emails/day total**, including inbound parsing.
    A busy day of forwarded invoices counts against it.

---

## Troubleshooting cheat-sheet

| Symptom | Check |
|---|---|
| App won't load | Vercel → your project → **Logs**; or a missing env var |
| Login fails | Supabase → Authentication → Users — did the user exist? |
| Email webhook not creating invoices | SendGrid Inbound Parse settings; webhook URL token matches Vercel's secret |
| QBO connect fails | Intuit app → Redirect URI exact match; the QBO admin added as a developer user; client id/secret in Vercel |
| Extraction blank | OpenRouter key; see Vercel logs |

---

*Authored by Araza — for the operator (not a coder): follow sections in
order; each is click-and-paste.*
