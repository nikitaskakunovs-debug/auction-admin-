# 07 — Security model

Condensed from [`SECURITY.md`](../../SECURITY.md) (the authoritative document)
plus implementation notes. See also chapter 03 §Auth.

## Passwords
- scrypt N=2¹⁵ r=8 p=1, per-hash random salt, constant-time compare
  (`packages/db/src/password.ts`); format `scrypt$N$r$p$salt$hash`.
- Policy (`@auction/domain` `validatePassword`): ≥12 chars, ≥3 of 4 character
  classes, common-password blocklist, no email/name echo. Enforced on
  creation, admin-set updates, and self-service change.

## Two-factor (mandatory for every admin)
- Step 1 (password) yields only a short-lived single-purpose **challenge
  token**; step 2 is TOTP (RFC 6238, ±1 step) or a one-time recovery code.
- First login forces enrollment before any session exists; the pending secret
  lives in Redis (15 min), never half-written to the DB.
- 10 recovery codes, shown once, stored as SHA-256, burned via a
  concurrent-safe conditional update.
- Trusted devices: hashed 32-byte cookie token, 30 d, skips TOTP only
  (password always required); revoked on any credential change.

## Login anti-abuse
- Dummy-hash verification for unknown accounts (timing never leaks
  existence); one generic error message.
- Redis per-**account** lockout (8 fails → 15 min) that survives restarts,
  spans instances, and can't be dodged by rotating IPs; per-IP global rate
  limit (300/min) in front; stricter caps on kiosk check-in (30/min) and the
  Jira webhook (120/min).

## Sessions & tokens
- 15-min HS256 access JWTs, pinned `alg`, `iss`/`aud` checks, `kind` claim —
  admin and bidder tokens are non-interchangeable by construction.
- Access token only in SPA memory (never localStorage). Refresh token:
  httpOnly + Secure + SameSite=Strict cookie scoped to `/api/auth`, hashed at
  rest, **rotated on every use**; reuse of a rotated token revokes the whole
  family and writes an audit row (theft detection).
- Password change / deactivation / role change revokes all refresh tokens and
  trusted devices; access tokens die within 15 min.

## Authorization
- Deny-by-default action-level RBAC: ~45 permissions × 7 roles, enforced per
  route via `requirePermission`, only mirrored (never trusted) in the UI.
- The super-admin matrix is locked; the last active super admin cannot be
  demoted or deactivated.
- Payload hygiene as authorization: reserves, proxy maxima, and customer PII
  are stripped server-side from every public payload and WS event.

## Transport & headers
- helmet: HSTS (180 d, includeSubDomains), nosniff, frameguard, strict
  referrer policy. CSP is set by the SPA/Next layers, not the JSON API.
- CORS: explicit origin allowlist with credentials — never a wildcard.
- `TRUST_PROXY=1` behind Caddy so rate limiting and lockout see real client
  IPs.

## Production guards
Boot fails unless `JWT_SECRET` (≥32 chars) and `CORS_ORIGINS` are set, and
every `live`-mode provider has its credentials — a deploy can't silently fall
back to dev secrets or permissive origins.

## Audit
Append-only `audit_log` for logins, lockouts, recovery-code use,
refresh-reuse detection, password changes, role/permission edits, and every
destructive business action (void bid, cancel, refund, erase, suspend…) with
the real actor and a snapshot label. Blocking/suspending an account is only
possible through the dedicated audited endpoints — the generic PATCH cannot
flip the flag.

## Known follow-ups
Encrypt the TOTP secret column at rest (envelope/KMS); optional
WebAuthn/passkeys; QR image for TOTP enrollment (currently secret +
`otpauth://` URI).
