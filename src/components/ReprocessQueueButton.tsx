"use client";

// Reprocess a failed / "no invoice data" queue entry — re-queues its ingest
// job so the current extraction logic runs again (no need to re-forward the
// email or re-upload, which could trigger duplicate warnings). Admin only
// (the server action enforces it).
export function ReprocessQueueButton({
  jobId,
  action,
}: {
  jobId: string;
  action: (jobId: string) => Promise<void>;
}) {
  return (
    <form
      action={async () => {
        if (
          window.confirm(
            "Reprocess this document with the current extraction logic?"
          )
        ) {
          await action(jobId);
        }
      }}
    >
      <button
        type="submit"
        title="Reprocess"
        className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
      >
        Reprocess
      </button>
    </form>
  );
}
