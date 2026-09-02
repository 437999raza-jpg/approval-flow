-- Internal (house) organizations.
--
-- Ufirst runs its own production work on Flow. It needs full product
-- access, but it is never invoiced — there is no customer on the other
-- side of it. Until now the only way to express that was to put it on a
-- paid plan and simply never charge it, which meant its Billing page
-- kept showing a plan grid, a monthly charge and a "Pay now" button for
-- money that is never going to move.
--
-- A dedicated flag rather than a magic plan value: "who they are" and
-- "what they're on" are different questions, and an internal org still
-- has a real plan deciding its features. Platform-admin write only.
--
-- Authored by Araza.

alter table organizations
  add column if not exists is_internal boolean not null default false;

comment on column organizations.is_internal is
  'House account: full product access, never billed and never trial-locked. Suppresses all payment UI on /billing. Set from /admin/organizations by a platform admin.';
