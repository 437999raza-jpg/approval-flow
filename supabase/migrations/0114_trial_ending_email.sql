-- "No trial-ending email exists at all" — TrialBanner.tsx already
-- escalates its tone in-app as the trial runs out, but that only ever
-- works if the admin happens to be looking at flow in those final
-- days. Miss that window and the only outcome is getting locked out
-- with zero advance warning — the same "if I'm not there, there's no
-- way to know" pattern as everything else notification-related this
-- session.
--
-- One-shot per trial (unlike the no-approver notice, which re-fires):
-- there's exactly one moment this matters, and stepEnteredReset-style
-- clearing doesn't apply since a trial doesn't reset.
--
-- Authored by Araza.

alter table organizations add column if not exists trial_reminder_sent_at timestamptz;
