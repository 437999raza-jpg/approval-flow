"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MultiSelect, type MultiSelectOption } from "@/components/MultiSelect";

export interface DocumentSearchFilters {
  status: string[];
  holder: string[];
  requester: string[];
  approvedBy: string[];
  supplier: string[];
  customer: string[];
  class: string[];
  number: string;
  dateFrom: string;
  dateTo: string;
  amountFrom: string;
  amountTo: string;
}

interface DocumentSearchModalProps {
  statuses: MultiSelectOption[];
  members: MultiSelectOption[];
  vendors: MultiSelectOption[];
  projects: MultiSelectOption[];
  classes: MultiSelectOption[];
  initial: DocumentSearchFilters;
  activeCount: number;
  // Phase 2: when provided, "Search" hands the resulting relative URL
  // (path + query string) to this callback instead of a real Next.js
  // navigation — same pattern as SearchInput's onNavigate.
  onNavigate?: (url: string) => void;
}

const EMPTY: DocumentSearchFilters = {
  status: [],
  holder: [],
  requester: [],
  approvedBy: [],
  supplier: [],
  customer: [],
  class: [],
  number: "",
  dateFrom: "",
  dateTo: "",
  amountFrom: "",
  amountTo: "",
};

// ApprovalMax-style advanced search: multi-select fields (vendor A OR vendor
// B, etc.) layered on top of whatever sidebar view/quick-search is active.
// "Currently holding" — who has the document right now, by name — is the
// field ApprovalMax's own search screen is missing.
export function DocumentSearchModal({
  statuses,
  members,
  vendors,
  projects,
  classes,
  initial,
  activeCount,
  onNavigate,
}: DocumentSearchModalProps) {
  const router = useRouter();
  const go = (url: string) => (onNavigate ? onNavigate(url) : router.push(url));
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<DocumentSearchFilters>(initial);

  // useState(initial) only snapshots `initial` on this component's first
  // mount — it never re-syncs on its own if the real applied filters
  // change afterward through some other path (e.g. the URL/advanced
  // filters get set before this modal has ever been opened). That left
  // the "Filters" badge correctly showing an active count while the
  // modal itself opened to a blank, out-of-sync draft. Re-snapshot the
  // draft from the current committed filters every time the modal is
  // opened, so what's shown always matches what's actually active.
  function openModal() {
    setFilters(initial);
    setOpen(true);
  }

  function set<K extends keyof DocumentSearchFilters>(key: K, value: DocumentSearchFilters[K]) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  function apply() {
    const params = new URLSearchParams();
    if (filters.status.length) params.set("status", filters.status.join(","));
    if (filters.holder.length) params.set("holder", filters.holder.join(","));
    if (filters.requester.length) params.set("requester", filters.requester.join(","));
    if (filters.approvedBy.length) params.set("approvedBy", filters.approvedBy.join(","));
    if (filters.supplier.length) params.set("supplier", filters.supplier.join(","));
    if (filters.customer.length) params.set("customer", filters.customer.join(","));
    if (filters.class.length) params.set("class", filters.class.join(","));
    if (filters.number) params.set("number", filters.number);
    if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
    if (filters.dateTo) params.set("dateTo", filters.dateTo);
    if (filters.amountFrom) params.set("amountFrom", filters.amountFrom);
    if (filters.amountTo) params.set("amountTo", filters.amountTo);
    go(`/dashboard${params.toString() ? `?${params.toString()}` : ""}`);
    setOpen(false);
  }

  // "Clear" used to only reset the in-progress draft (setFilters(EMPTY))
  // — the actually-applied filters (the URL/advanced state driving the
  // "Filters" badge) never changed, so a filter stayed active until
  // "Search" was pressed again afterward. Clear now applies immediately,
  // same as Search does, just with an empty set — but stays open,
  // unlike Search: clearing is usually the start of building a new
  // search, not a reason to leave. The "×" button is there if closing
  // is what's actually wanted.
  function clearAndApply() {
    setFilters(EMPTY);
    go("/dashboard");
  }

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
      >
        Filters
        {activeCount > 0 && (
          <span className="rounded-full bg-blue-600 px-1.5 py-0.5 text-xs font-medium text-white">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-8"
          onClick={() => setOpen(false)}
        >
          <div
            className="max-h-full w-full max-w-4xl overflow-y-auto rounded-lg bg-white shadow-elevation-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h2 className="text-lg font-semibold">Document search</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={clearAndApply}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={apply}
                  className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Search
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="ml-1 text-lg leading-none text-slate-400 hover:text-slate-600"
                >
                  ×
                </button>
              </div>
            </div>

            <div className="space-y-6 p-6">
              <div>
                <h3 className="text-sm font-semibold text-slate-700">People</h3>
                <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4">
                  <MultiSelect
                    label="Currently holding"
                    options={members}
                    selected={filters.holder}
                    onChange={(v) => set("holder", v)}
                  />
                  <MultiSelect
                    label="Requester"
                    options={members}
                    selected={filters.requester}
                    onChange={(v) => set("requester", v)}
                  />
                  <MultiSelect
                    label="Approved by"
                    options={members}
                    selected={filters.approvedBy}
                    onChange={(v) => set("approvedBy", v)}
                  />
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-slate-700">Document</h3>
                <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4">
                  <MultiSelect
                    label="Status"
                    options={statuses}
                    selected={filters.status}
                    onChange={(v) => set("status", v)}
                  />
                  <MultiSelect
                    label="Class"
                    options={classes}
                    selected={filters.class}
                    onChange={(v) => set("class", v)}
                  />
                  <MultiSelect
                    label="Supplier"
                    options={vendors}
                    selected={filters.supplier}
                    onChange={(v) => set("supplier", v)}
                  />
                  <MultiSelect
                    label="Customer"
                    options={projects}
                    selected={filters.customer}
                    onChange={(v) => set("customer", v)}
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">
                  Invoice number
                </label>
                <input
                  value={filters.number}
                  onChange={(e) => set("number", e.target.value)}
                  placeholder="Enter number"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <h3 className="text-sm font-semibold text-slate-700">Bill date</h3>
                <div className="mt-3 grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600">From</label>
                    <input
                      type="date"
                      value={filters.dateFrom}
                      onChange={(e) => set("dateFrom", e.target.value)}
                      className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600">To</label>
                    <input
                      type="date"
                      value={filters.dateTo}
                      onChange={(e) => set("dateTo", e.target.value)}
                      className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-slate-700">Amount</h3>
                <div className="mt-3 grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600">From</label>
                    <input
                      type="number"
                      value={filters.amountFrom}
                      onChange={(e) => set("amountFrom", e.target.value)}
                      className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600">To</label>
                    <input
                      type="number"
                      value={filters.amountTo}
                      onChange={(e) => set("amountTo", e.target.value)}
                      className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
