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
  const [active, setActive] = useState(0);
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
    setActive(0);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (query === null) return;
    if (e.key === "ArrowDown" && filtered.length > 0) {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp" && filtered.length > 0) {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && filtered.length > 0) {
      e.preventDefault();
      selectMember(filtered[active] ?? filtered[0]);
    } else if (e.key === "Escape") {
      // Back out of mention mode entirely: close the dropdown AND remove
      // the "@query" text it was matching against — closing the dropdown
      // alone left "@partial" sitting in the message, needing an extra
      // backspace (or several) to actually clean up after changing your
      // mind about mentioning someone.
      const el = inputRef.current;
      const pos = el?.selectionStart ?? text.length;
      const uptoCursor = text.slice(0, pos);
      const afterCursor = text.slice(pos);
      const newUpto = uptoCursor.replace(/(?:^|\s)@(\S*)$/, (m) =>
        m.startsWith(" ") ? " " : ""
      );
      setText(newUpto + afterCursor);
      setQuery(null);
      requestAnimationFrame(() => el?.focus());
    }
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
          {filtered.map((m, i) => (
            <button
              key={m.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => selectMember(m)}
              onMouseEnter={() => setActive(i)}
              className={`block w-full px-3 py-1.5 text-left text-sm ${
                i === active ? "bg-blue-50 text-blue-700" : "text-slate-700"
              }`}
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
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      />
      <input type="hidden" name="mentioned_ids" value={mentionedIds.join(",")} />
    </div>
  );
}
