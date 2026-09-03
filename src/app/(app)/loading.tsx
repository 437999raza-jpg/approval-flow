import { BrandLoading } from "@/components/BrandLoading";

// Fallback for every page in the app shell that has no loading.tsx of
// its own — so a new route can never ship with a blank frame again.
export default function Loading() {
  return <BrandLoading />;
}
