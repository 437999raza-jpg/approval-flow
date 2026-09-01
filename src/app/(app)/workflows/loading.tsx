import { AppPageLoading } from "@/components/AppPageLoading";

export default function Loading() {
  return (
    <AppPageLoading
      title="Opening workflows"
      description="Loading approval flows, approvers, and rule settings…"
    />
  );
}
