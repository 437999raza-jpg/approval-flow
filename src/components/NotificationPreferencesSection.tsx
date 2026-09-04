"use client";

import { useState } from "react";
import { clsx } from "clsx";
import type { NotificationPreferences } from "@/lib/notification-preferences";

// A handful of common IANA zones covering this customer base — not an
// exhaustive Intl.supportedValuesOf("timeZone") dump, which is mostly
// noise for a company picking one zone for its whole team.
const TIMEZONE_OPTIONS = [
  { value: "America/St_Johns", label: "Newfoundland Time" },
  { value: "America/Halifax", label: "Atlantic Time" },
  { value: "America/Toronto", label: "Eastern Time" },
  { value: "America/Winnipeg", label: "Central Time" },
  { value: "America/Edmonton", label: "Mountain Time" },
  { value: "America/Vancouver", label: "Pacific Time" },
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({
  value: h,
  label: new Date(2000, 0, 1, h).toLocaleTimeString("en-US", { hour: "numeric", hour12: true }),
}));

type DayOption = { code: string; label: string };

export function NotificationPreferencesSection({
  initialPrefs,
  dayOptions,
  saveAction,
}: {
  initialPrefs: NotificationPreferences;
  dayOptions: DayOption[];
  saveAction: (formData: FormData) => Promise<void>;
}) {
  const [prefs, setPrefs] = useState(initialPrefs);
  const [saved, setSaved] = useState(initialPrefs);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(prefs) !== JSON.stringify(saved);

  const toggleDay = (code: string) => {
    setPrefs((p) => ({
      ...p,
      digest_days: p.digest_days.includes(code)
        ? p.digest_days.filter((d) => d !== code)
        : [...p.digest_days, code],
    }));
  };

  return (
    <form
      className="mt-3 space-y-4 rounded-lg border border-slate-200 bg-white shadow-elevation-1 p-4"
      action={async (formData) => {
        setSaving(true);
        await saveAction(formData);
        setSaved(prefs);
        setSaving(false);
      }}
    >
      {dayOptions.map((d) => (
        <input key={d.code} type="hidden" name={`digest_day_${d.code}`} value={prefs.digest_days.includes(d.code) ? "on" : ""} />
      ))}

      <ToggleRow
        label="Mentions"
        description={"Email me when someone @mentions me in a comment."}
        checked={prefs.mentions_enabled}
        name="mentions_enabled"
        onChange={(v) => setPrefs((p) => ({ ...p, mentions_enabled: v }))}
      />
      <ToggleRow
        label="It's your turn"
        description="Email me when an invoice is assigned to me for approval."
        checked={prefs.assigned_enabled}
        name="assigned_enabled"
        onChange={(v) => setPrefs((p) => ({ ...p, assigned_enabled: v }))}
      />

      <div className="border-t border-slate-100 pt-4">
        <ToggleRow
          label="Daily digest"
          description="A daily email summarizing what's waiting on you."
          checked={prefs.digest_enabled}
          name="digest_enabled"
          onChange={(v) => setPrefs((p) => ({ ...p, digest_enabled: v }))}
        />

        {prefs.digest_enabled && (
          <div className="mt-3 space-y-3 pl-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {dayOptions.map((d) => {
                const active = prefs.digest_days.includes(d.code);
                return (
                  <button
                    key={d.code}
                    type="button"
                    onClick={() => toggleDay(d.code)}
                    className={clsx(
                      "flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium",
                      active ? "bg-brand-green text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                    )}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <span>at</span>
              <select
                name="digest_hour"
                value={prefs.digest_hour}
                onChange={(e) => setPrefs((p) => ({ ...p, digest_hour: Number(e.target.value) }))}
                className="rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
              >
                {HOUR_OPTIONS.map((h) => (
                  <option key={h.value} value={h.value}>
                    {h.label}
                  </option>
                ))}
              </select>
              <select
                name="timezone"
                value={prefs.timezone}
                onChange={(e) => setPrefs((p) => ({ ...p, timezone: e.target.value }))}
                className="rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
              >
                {TIMEZONE_OPTIONS.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-slate-100 pt-4">
        <button
          type="submit"
          disabled={!dirty || saving}
          className={clsx(
            "rounded-md px-3 py-1.5 text-xs font-medium",
            dirty && !saving
              ? "bg-slate-800 text-white hover:bg-slate-700"
              : "cursor-default bg-slate-100 text-slate-400"
          )}
        >
          {saving ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
      </div>
    </form>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  name,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  name: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-sm font-medium text-slate-700">{label}</p>
        <p className="mt-0.5 text-xs text-slate-500">{description}</p>
      </div>
      <label className="relative inline-flex flex-none cursor-pointer items-center">
        <input
          type="checkbox"
          name={name}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <div className="h-5 w-9 rounded-full bg-slate-200 peer-checked:bg-brand-green transition-colors" />
        <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
      </label>
    </div>
  );
}
