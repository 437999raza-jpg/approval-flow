"use client";

// Trash button for the Email queue — admin only (the server action enforces
// it too). Confirms before removing, then revalidates so the list refreshes.
export function RemoveEmailButton({
  id,
  action,
}: {
  id: string;
  action: (id: string) => Promise<void>;
}) {
  return (
    <form
      action={async () => {
        if (window.confirm("Remove this entry from the email queue?")) {
          await action(id);
        }
      }}
    >
      <button
        type="submit"
        title="Remove from queue"
        className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-rose-50 hover:text-rose-600"
      >
        ✕
      </button>
    </form>
  );
}
