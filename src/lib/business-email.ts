// Flow is sold to businesses, so accounts must be on a company domain.
// This blocks free consumer mailboxes rather than trying to allow-list
// every legitimate company domain — an allow-list would need maintaining
// forever and would reject every new customer on their first visit.
//
// Note this is about the DOMAIN, not the sign-in provider: a company on
// Google Workspace signs in with "Continue with Google" as
// name@theircompany.com and is perfectly valid. It's name@gmail.com that
// isn't. So the provider buttons stay exactly as they are and the check
// happens on the resulting address.
//
// Authored by Araza.

const CONSUMER_DOMAINS = new Set([
  // Google
  "gmail.com",
  "googlemail.com",
  // Microsoft
  "outlook.com",
  "outlook.co.uk",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "live.com",
  "live.ca",
  "live.co.uk",
  "msn.com",
  "passport.com",
  // Yahoo / AOL
  "yahoo.com",
  "yahoo.ca",
  "yahoo.co.uk",
  "yahoo.fr",
  "ymail.com",
  "rocketmail.com",
  "aol.com",
  // Apple — including the relay address "Sign in with Apple" hands back
  // when someone chooses "Hide My Email", which is deliberately
  // untraceable to a company and can't be contacted about billing.
  "icloud.com",
  "me.com",
  "mac.com",
  "privaterelay.appleid.com",
  // Other common free consumer providers
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "mail.com",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
  "fastmail.com",
  "hushmail.com",
  "tutanota.com",
  "tuta.io",
  // Canadian ISP mailboxes — common for small contractors, still personal
  "sympatico.ca",
  "rogers.com",
  "bell.net",
  "shaw.ca",
  "telus.net",
  "videotron.ca",
  "cogeco.ca",
  // Disposable / throwaway
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "yopmail.com",
  "temp-mail.org",
  "trashmail.com",
  "sharklasers.com",
]);

export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at === -1 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

export function isBusinessEmail(email: string | null | undefined): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  // A domain with no dot can't be a real public domain (and "localhost"
  // and friends shouldn't get through either).
  if (!domain.includes(".")) return false;
  return !CONSUMER_DOMAINS.has(domain);
}

// One wording for every rejection path (client-side form, signup action,
// OAuth callback, teammate invite) so the rule reads the same wherever
// someone hits it.
export const BUSINESS_EMAIL_MESSAGE =
  "Please use your work email address — Flow accounts can't be created with personal mailboxes like Gmail, Outlook or iCloud.";
