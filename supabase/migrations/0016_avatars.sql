-- Approval Flow: profile photo storage.
-- Profiles already have `avatar_url` (migration 0001) but nothing has ever
-- written to it. This adds a public "avatars" bucket with per-user upload
-- policies: each user may only write to their own folder, path convention
-- {user_id}/avatar.{ext}. Reads are public since avatar images aren't
-- sensitive and this avoids re-signing a URL everywhere one is displayed.
-- Authored by Araza. Idempotent — safe to re-run.

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatars: public read" on storage.objects;
create policy "avatars: public read"
  on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists "avatars: users manage their own" on storage.objects;
create policy "avatars: users manage their own"
  on storage.objects for all
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
