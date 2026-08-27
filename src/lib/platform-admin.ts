// Cross-org "can create new tenants" check, distinct from an org's own
// admin role (organization_members.role). Backed by an env var rather than
// a DB table since there's no self-serve signup yet — only the operator
// selling this app to clients needs it.
const PLATFORM_ADMIN_EMAILS = (process.env.PLATFORM_ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export function isPlatformAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return PLATFORM_ADMIN_EMAILS.includes(email.toLowerCase());
}
