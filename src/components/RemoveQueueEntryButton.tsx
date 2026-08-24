"use client";

// Trash button for the Queue page — admin only (the server actions enforce
// it too). Confirms before removing, then revalidates so the list refreshes.
export function RemoveQueueEntryButton({
  kind,
  id,
  emailAction,
  uploadAction,
}: {
  kind: "email" | "upload";
  id: string;
  emailAction: (id: string) => Promise<void>;
  uploadAction: (id: string) => Promise<void>;
}) {
  return (
    <form
      action={async () => {
        if (window.confirm("Remove this entry from the queue?")) {
          if (kind === "email") await emailAction(id);
          else await uploadAction(id);
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
