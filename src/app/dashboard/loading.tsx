import { BrandLoading } from "@/components/BrandLoading";

// The Dashboard had no loading state at all — it is the screen people
// sit in front of, and the one that showed a blank frame while the
// invoice list and the org's workflow data were fetched.
export default function Loading() {
  return <BrandLoading full label="Opening your invoices…" />;
}
