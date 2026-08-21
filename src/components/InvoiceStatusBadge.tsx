import { clsx } from "clsx";
import type { InvoiceStatus } from "@/lib/supabase/types";

const STYLES: Record<InvoiceStatus, string> = {
  on_review: "bg-violet-100 text-violet-800",
  on_approval: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-slate-100 text-slate-500",
  rejected: "bg-red-100 text-red-800",
  on_hold: "bg-orange-100 text-orange-800",
};

const LABELS: Record<InvoiceStatus, string> = {
  on_review: "On review",
  on_approval: "On approval",
  approved: "Approved",
  cancelled: "Cancelled",
  rejected: "Rejected",
  on_hold: "On hold",
};

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        STYLES[status]
      )}
    >
      {LABELS[status]}
    </span>
  );
}
