/**
 * Admin password policy. Pure and framework-free so it can be enforced at the
 * API and mirrored in the UI. Deliberately NIST-flavoured: length is the main
 * lever, plus a handful of character classes and a block on the most trivial
 * choices — we optimise for long passphrases, not unmemorable symbol soup.
 */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

const COMMON = new Set([
  "password",
  "password1",
  "password123",
  "admin123",
  "administrator",
  "letmein",
  "welcome",
  "changeme",
  "qwerty",
  "12345678",
  "123456789",
  "1234567890",
  "iloveyou",
]);

export interface PasswordCheck {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a candidate admin password. `context` (email/name) is checked so a
 * password can't just echo the account it protects.
 */
export function validatePassword(password: string, context: { email?: string; name?: string } = {}): PasswordCheck {
  const errors: string[] = [];
  const pw = password ?? "";

  if (pw.length < MIN_PASSWORD_LENGTH) errors.push(`Must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (pw.length > MAX_PASSWORD_LENGTH) errors.push(`Must be at most ${MAX_PASSWORD_LENGTH} characters.`);

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 3) errors.push("Use at least three of: lowercase, uppercase, digits, symbols.");

  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) errors.push("This password is too common.");
  if (/^(.)\1+$/.test(pw)) errors.push("Avoid a single repeated character.");

  const localPart = context.email?.split("@")[0]?.toLowerCase();
  if (localPart && localPart.length >= 3 && lower.includes(localPart)) errors.push("Must not contain your email.");
  const name = context.name?.toLowerCase().trim();
  if (name && name.length >= 3 && lower.includes(name)) errors.push("Must not contain your name.");

  return { ok: errors.length === 0, errors };
}
