import { createAdminClient } from "@/lib/supabase/admin";

// Flow's own OpenRouter cost tracking (COGS, not customer-facing) — one
// row per call into llm_usage_events, read by the separate Ufirst Ops app.
// Best-effort via the service-role client: a logging failure must never
// block invoice extraction or classification. Authored by Araza.

export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

export async function recordLlmUsage(
  organizationId: string,
  purpose: "extract" | "classify",
  model: string,
  usage: OpenRouterUsage | undefined
): Promise<void> {
  if (!usage) return;
  try {
    await createAdminClient().from("llm_usage_events").insert({
      organization_id: organizationId,
      purpose,
      model,
      prompt_tokens: usage.prompt_tokens ?? null,
      completion_tokens: usage.completion_tokens ?? null,
      total_tokens: usage.total_tokens ?? null,
      cost_usd: usage.cost ?? null,
    });
  } catch (err) {
    console.error("recordLlmUsage failed:", err);
  }
}
