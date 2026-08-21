"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

// A plain text input with @mention autocomplete: typing "@" shows a
// dropdown of org members filtered by what's typed; picking one inserts
// "@Name " into the visible text and records their id in a hidden
// `mentioned_ids` field the form posts alongside `body`. Only names
// picked from the dropdown count as real mentions (free-typed "@text"
// that doesn't match anyone doesn't notify anyone). Authored by Araza.
export function MentionComposer({
  members,
  placeholder,
}: {
  members: { id: string; label: string }[];
  placeholder: string;
}) {
  const [text, setText] = useState("");
  const [mentionedIds, setMentionedIds] = useState<string[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A controlled input doesn't get the native "form resets after a
  // successful action" behavior an uncontrolled one would — clear it
  // ourselves on the pending -> not-pending transition (i.e. right after
  // the post completes), not on every render.
  const { pending } = useFormStatus();
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) {
      setText("");
      setMentionedIds([]);
      setQuery(null);
    }
    wasPending.current = pending;
  }, [pending]);

  const filtered =
    query === null
      ? []
      : members
          .filter((m) => m.label.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 6);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    const pos = e.target.selectionStart ?? value.length;
    setText(value);

    const uptoCursor = value.slice(0, pos);
    const match = uptoCursor.match(/(?:^|\s)@(\S*)$/);
    setQuery(match ? match[1] : null);
  }

  function selectMember(member: { id: string; label: string }) {
    const el = inputRef.current;
    const pos = el?.selectionStart ?? text.length;
    const uptoCursor = text.slice(0, pos);
    const afterCursor = text.slice(pos);
    const newUpto = uptoCursor.replace(/(?:^|\s)@(\S*)$/, (m) =>
      (m.startsWith(" ") ? " " : "") + `@${member.label} `
    );
    setText(newUpto + afterCursor);
    setMentionedIds((prev) => (prev.includes(member.id) ? prev : [...prev, member.id]));
    setQuery(null);
    requestAnimationFrame(() => el?.focus());
  }

  return (
    <div className="relative min-w-0 flex-1">
      {query !== null && filtered.length > 0 && (
        <div className="absolute bottom-full left-0 z-10 mb-1 w-56 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          {filtered.map((m) => (
            <button
              key={m.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => selectMember(m)}
              className="block w-full px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
      <input
        ref={inputRef}
        name="body"
        required
        autoComplete="off"
        value={text}
        onChange={handleChange}
        placeholder={placeholder}
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      />
      <input type="hidden" name="mentioned_ids" value={mentionedIds.join(",")} />
    </div>
  );
}
