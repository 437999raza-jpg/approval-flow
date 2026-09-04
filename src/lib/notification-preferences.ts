import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

// Defaults for any user with no row yet (migration 0115) — weekdays-only
// digest at 9am in a Canadian timezone (this customer base's default),
// everything else on. Kept in one place so the Settings UI, the cron,
// and notifyNewApprovers/addComment's email gates can't drift apart on
// what "not configured yet" means.
export const DEFAULT_NOTIFICATION_PREFERENCES = {
  mentions_enabled: true,
  assigned_enabled: true,
  digest_enabled: true,
  digest_days: ["mon", "tue", "wed", "thu", "fri"] as string[],
  digest_hour: 9,
  timezone: "America/Toronto",
  digest_last_sent_at: null as string | null,
  // Whether the "it's your turn" email includes one-click Approve/Reject
  // buttons (migration 0116). On by default — that's the point of the
  // feature — but someone on a shared inbox, or who'd rather a decision
  // always go through a login, can turn it off.
  approve_by_email_enabled: true,
};

export type NotificationPreferences = typeof DEFAULT_NOTIFICATION_PREFERENCES;

export async function getNotificationPreferences(
  supabase: SupabaseClient<Database>,
  userId: string
): Promise<NotificationPreferences> {
  const { data } = await supabase
    .from("user_notification_preferences")
    .select("mentions_enabled, assigned_enabled, digest_enabled, digest_days, digest_hour, timezone, digest_last_sent_at, approve_by_email_enabled")
    .eq("user_id", userId)
    .maybeSingle();
  return data ? { ...DEFAULT_NOTIFICATION_PREFERENCES, ...data } : DEFAULT_NOTIFICATION_PREFERENCES;
}

// Bulk variant for the reminders cron, which checks every pending
// approver's digest schedule on every run — one query instead of one
// per user.
export async function getNotificationPreferencesMap(
  supabase: SupabaseClient<Database>,
  userIds: string[]
): Promise<Map<string, NotificationPreferences>> {
  const map = new Map<string, NotificationPreferences>();
  if (userIds.length === 0) return map;
  const { data } = await supabase
    .from("user_notification_preferences")
    .select("user_id, mentions_enabled, assigned_enabled, digest_enabled, digest_days, digest_hour, timezone, digest_last_sent_at, approve_by_email_enabled")
    .in("user_id", [...new Set(userIds)]);
  for (const row of data ?? []) {
    const { user_id, ...prefs } = row;
    map.set(user_id, { ...DEFAULT_NOTIFICATION_PREFERENCES, ...prefs });
  }
  return map;
}

export function prefsFor(map: Map<string, NotificationPreferences>, userId: string): NotificationPreferences {
  return map.get(userId) ?? DEFAULT_NOTIFICATION_PREFERENCES;
}

const WEEKDAY_CODES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

// Intl.DateTimeFormat resolves any IANA zone without a runtime dependency
// — Node's ICU build already carries the full tz database. "hour12: false"
// can hand back "24" for midnight in some locales, so that gets folded
// back to 0.
function localHourAndWeekday(timeZone: string, now: Date): { hour: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);
  const hourPart = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const weekdayPart = (parts.find((p) => p.type === "weekday")?.value ?? "").toLowerCase().slice(0, 3);
  return { hour: hourPart === 24 ? 0 : hourPart, weekday: weekdayPart };
}

// True once per qualifying hour: it's currently the user's chosen day
// and hour in THEIR timezone, and they haven't already gotten one in
// the last 20 hours (guards against the cron firing twice inside the
// same qualifying hour from clock drift, without needing a stricter
// "exactly once ever today" check that a missed run could then skip
// forever).
export function isDigestDue(prefs: NotificationPreferences, now = new Date()): boolean {
  if (!prefs.digest_enabled) return false;
  const { hour, weekday } = localHourAndWeekday(prefs.timezone, now);
  if (hour !== prefs.digest_hour) return false;
  if (!prefs.digest_days.includes(weekday)) return false;
  if (prefs.digest_last_sent_at) {
    const hoursSince = (now.getTime() - new Date(prefs.digest_last_sent_at).getTime()) / (60 * 60 * 1000);
    if (hoursSince < 20) return false;
  }
  return true;
}

export const DIGEST_DAY_OPTIONS: { code: (typeof WEEKDAY_CODES)[number]; label: string }[] = [
  { code: "mon", label: "Mo" },
  { code: "tue", label: "Tu" },
  { code: "wed", label: "We" },
  { code: "thu", label: "Th" },
  { code: "fri", label: "Fr" },
  { code: "sat", label: "Sa" },
  { code: "sun", label: "Su" },
];
