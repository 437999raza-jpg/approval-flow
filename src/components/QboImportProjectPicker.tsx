"use client";

import { useState } from "react";
import { MultiSelect } from "./MultiSelect";

// Which jobs to scope an import to — searchable multi-select rather than
// scrolling a plain <select> through 456 entries, using the same "N
// values" pill + search pattern already used for suppliers and the
// Holdback report. Renders its hidden inputs into whatever <form> it's
// mounted inside (the admin organizations page's server-rendered form),
// so submitting still just works via the browser's own FormData — no
// client-side submit handler needed.
// Authored by Araza.
export function QboImportProjectPicker({
  projects,
}: {
  projects: { id: string; name: string }[];
}) {
  const [selected, setSelected] = useState<string[]>([]);

  return (
    <div className="min-w-[16rem]">
      {selected.map((id) => (
        <input key={id} type="hidden" name="project_ids" value={id} />
      ))}
      <MultiSelect
        label="Only these jobs (optional)"
        options={projects.map((p) => ({ id: p.id, label: p.name }))}
        selected={selected}
        onChange={setSelected}
      />
    </div>
  );
}
