-- One-time TOTP recovery codes, generated at enrollment. Supabase's own
-- auth.mfa API has no native backup-code concept, so this is built
-- entirely at the app layer. A plain auth.uid()-scoped RLS policy works
-- for both generation (right after enrollment) and consumption (at
-- /login/mfa, session is authenticated but only aal1 — RLS doesn't care
-- about aal unless a policy explicitly checks it, which this one doesn't).
create table mfa_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index on mfa_recovery_codes(user_id);

alter table mfa_recovery_codes enable row level security;
create policy "mfa_recovery_codes: own rows only" on mfa_recovery_codes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
