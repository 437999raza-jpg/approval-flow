import { clsx } from "clsx";
import type { InvoiceStatus } from "@/lib/supabase/types";

const STYLES: Record<InvoiceStatus, string> = {
  pending_review: "bg-violet-100 text-violet-800",
  pending: "bg-slate-100 text-slate-700",
  in_review: "bg-amber-100 text-amber-800",
  held: "bg-orange-100 text-orange-800",
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-red-100 text-red-800",
  paid: "bg-blue-100 text-blue-800",
};

const LABELS: Record<InvoiceStatus, string> = {
  pending_review: "Pending review",
  pending: "Pending",
  in_review: "In review",
  held: "On hold",
  approved: "Approved",
  rejected: "Rejected",
  paid: "Paid",
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
