"use client";

import { Combobox, type ComboboxOption } from "./Combobox";

// Thin wrapper so a Server Component page can use Combobox's search-as-
// you-type dropdown without needing autosave behavior. Combobox requires
// an `onCommit` callback (used elsewhere for the Bill panel's autosave
// fields) — a Server Component can't pass it an inline function directly
// (functions aren't serializable across the server/client boundary and
// throw a runtime "Functions cannot be passed directly to Client
// Components" error, not caught by the type checker), so this client
// component defines the no-op itself, one hop closer to the browser.
// Use this for any plain filter/search dropdown with a large option set
// (100+ items) where a native <select>'s scroll becomes unusable — the
// standard going forward for that case, per the Reports page filters.
// Authored by Araza.
export function FilterCombobox({
  name,
  formId,
  options,
  defaultValue,
  className,
  placeholder,
}: {
  name: string;
  formId: string;
  options: ComboboxOption[];
  defaultValue: string;
  className?: string;
  placeholder?: string;
}) {
  return (
    <Combobox
      name={name}
      formId={formId}
      options={options}
      defaultValue={defaultValue}
      className={className}
      placeholder={placeholder}
      onCommit={() => {}}
    />
  );
}
