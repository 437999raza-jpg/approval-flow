-- Retainage / holdback tracking.
--
-- Construction contracts withhold a percentage of every progress bill
-- until the job is substantially complete. Canada calls it holdback and
-- sets it in provincial construction acts (Ontario: 10%, released after
-- substantial performance is published). The US calls it retainage,
-- governs it state by state under prompt-pay statutes, commonly uses 5%,
-- and often steps it down at 50% completion. The UK and Australia call
-- it retention.
--
-- Same mechanism, three vocabularies and no single rulebook — so the
-- rate and the release trigger are configuration, never constants, and
-- the word itself is a per-org display setting. Columns are named
-- "retainage" throughout because it's the neutral term across all three
-- markets; what a customer READS comes from organizations.retainage_term.
--
-- Fluid books this to "HB Payable" (2-1031, QBO Id 420), an Other
-- Current Liability account. A liability balance carries no vendor and
-- no job — it is one number. So this ledger supplies BOTH dimensions,
-- plus the release calendar, and nets back to that balance.
--
-- The account is per customer, not a constant: the same file also has
-- "Holdbacks Payable" (2-1030), an Accounts-Payable-type account that
-- Fluid does not use. Which is exactly why it is configuration.
--
-- Authored by Araza.

-- Which word this org's people see, and their default rate.
alter table organizations
  add column if not exists retainage_term text not null default 'holdback'
    check (retainage_term in ('holdback', 'retainage', 'retention')),
  add column if not exists retainage_default_rate numeric(5, 2)
    check (retainage_default_rate is null
           or (retainage_default_rate >= 0 and retainage_default_rate <= 100)),
  -- QBO Account.Id the withheld amount is posted to (Fluid: 157).
  add column if not exists retainage_account_qbo_id text;

-- Rate and release are per project: a job can carry a different rate
-- from the org default, and release is a per-project event.
alter table projects
  add column if not exists retainage_rate numeric(5, 2)
    check (retainage_rate is null
           or (retainage_rate >= 0 and retainage_rate <= 100)),
  add column if not exists substantial_performance_at date,
  add column if not exists retainage_released_at timestamptz;

-- The sub-ledger: one row per invoice that had retainage withheld.
-- These rows net to the QBO account balance, and carry every dimension
-- that balance cannot — subcontractor, project, and release state.
create table if not exists invoice_retainage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  supplier_id uuid references suppliers(id) on delete set null,
  -- Positive amount withheld, in the invoice's own currency.
  amount numeric(14, 2) not null check (amount > 0),
  -- The rate actually applied, kept per row: the org default can change
  -- later, and a released holdback must always reconcile against what
  -- was really withheld at the time, not what the setting says today.
  rate numeric(5, 2),
  -- Whether the subcontractor showed the deduction on their own invoice
  -- or we withheld it ourselves. Different conversations six months on.
  source text not null default 'billed' check (source in ('billed', 'withheld')),
  status text not null default 'accrued'
    check (status in ('accrued', 'claim_requested', 'released', 'written_off')),
  claim_requested_at timestamptz,
  released_at timestamptz,
  -- The subcontractor's own invoice claiming the retainage back, once it
  -- arrives at the inbound address and is matched to this accrual.
  release_invoice_id uuid references invoices(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  -- One retainage row per invoice: a bill either had an amount withheld
  -- or it didn't.
  unique (invoice_id)
);

create index if not exists invoice_retainage_org_status_idx
  on invoice_retainage (organization_id, status);
create index if not exists invoice_retainage_project_idx
  on invoice_retainage (project_id);
create index if not exists invoice_retainage_supplier_idx
  on invoice_retainage (supplier_id);

alter table invoice_retainage enable row level security;

drop policy if exists "invoice_retainage: members can read" on invoice_retainage;
create policy "invoice_retainage: members can read" on invoice_retainage
  for select using (is_org_member(organization_id));

-- Writes go through server actions on the admin client, same as the
-- other money-touching tables in this schema.

-- Subcontractors have to be emailed to claim their retainage back, and
-- the vendor sync never asked QBO for an address. Without this the
-- claim-request step has nowhere to send.
alter table qbo_suppliers
  add column if not exists email text;

comment on table invoice_retainage is
  'Sub-ledger behind the QBO retainage/holdback account. One row per invoice with an amount withheld; rows net to that account balance and add the project and release-state dimensions QBO cannot carry.';
