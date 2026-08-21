// Outbound transactional email via Resend's HTTP API (no SDK dependency —
// a single POST, consistent with how this app calls OpenRouter). Every
// call is best-effort: a missing key/misconfiguration or a failed request
// never blocks the action that triggered it (e.g. posting a comment) —
// see the try/catch and the env-var guard below.
// Authored by Araza.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendMentionEmail({
  to,
  actorName,
  invoiceLabel,
  commentBody,
  invoiceUrl,
}: {
  to: string;
  actorName: string;
  invoiceLabel: string;
  commentBody: string;
  invoiceUrl: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) return;

  const html = `
    <p><strong>${escapeHtml(actorName)}</strong> mentioned you on <strong>${escapeHtml(invoiceLabel)}</strong>:</p>
    <p style="margin:12px 0;padding:12px;background:#f8fafc;border-left:3px solid #cbd5e1;white-space:pre-wrap;">${escapeHtml(commentBody)}</p>
    <p><a href="${invoiceUrl}" style="color:#2563eb;">Open the invoice →</a></p>
  `.trim();

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject: `${actorName} mentioned you on ${invoiceLabel}`,
        html,
      }),
    });
  } catch {
    // best-effort — the comment itself already posted successfully
  }
}
