import { redirect } from "next/navigation";

// The full-page chat here was replaced by a floating widget
// (SupportChatWidget.tsx, opened from the dashboard sidebar or its own
// corner bubble) — reported: taking over the whole screen left nothing
// on screen for a customer to point at when describing an error. Kept as
// a redirect rather than deleted outright so an old bookmark or link to
// /support still lands somewhere useful instead of 404ing.
export default function SupportPage() {
  redirect("/dashboard");
}
