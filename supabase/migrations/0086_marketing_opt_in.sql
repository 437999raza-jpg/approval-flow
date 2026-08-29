-- 0086: the signup form's "I agree to receive news, insights and
-- special offers" checkbox needs somewhere real to land, not just a
-- cosmetic checkbox.
alter table profiles add column if not exists marketing_opt_in boolean not null default false;
