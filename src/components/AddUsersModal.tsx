"use client";

import { useState } from "react";

interface RoleOption {
  value: string;
  label: string;
}

export function AddUsersModal({
  inviteAction,
  roles,
}: {
  inviteAction: (formData: FormData) => Promise<void>;
  roles: RoleOption[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
      >
        + Add new users
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-8"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h2 className="text-lg font-semibold">Add new user</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="text-lg leading-none text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            </div>
            <form
              action={async (formData) => {
                await inviteAction(formData);
                setOpen(false);
              }}
              className="space-y-3 p-6"
            >
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Name</label>
                <input
                  name="full_name"
                  placeholder="Jane Smith"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Email</label>
                <input
                  name="email"
                  type="email"
                  required
                  placeholder="teammate@company.com"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Role</label>
                <select
                  name="role"
                  defaultValue={roles[0]?.value}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                >
                  {roles.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                  Invite
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
