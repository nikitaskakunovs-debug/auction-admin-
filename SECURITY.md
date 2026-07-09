# Security model — admin panel

The admin panel guards the whole business (bidders' PII, orders, invoices, the
role matrix), so it is defended in depth. This document is the map.

## Authentication

- **Passwords** are hashed with scrypt (N=2¹⁵) and compared in constant time
  (`packages/db/src/password.ts`). A policy (`@auction/domain` `validatePassword`)
  requires ≥12 chars and 3 character classes, and blocks common/echoing values;
  it is enforced on admin creation, updates, and self-service password change.
- **Two-factor is mandatory.** Every admin logs in in two steps:
  1. email + password → a short-lived, single-purpose *challenge token* (no
     access to anything but step 2);
  2. a TOTP code (RFC 6238, verified in `@auction/domain` against the enrolled
     secret, ±1 time-step drift) — or a one-time **recovery code**.
  A brand-new admin's first login forces TOTP **enrollment** before any session
  is issued. Recovery codes are shown once and stored only as SHA-256 hashes;
  each is burned on use (concurrent-safe conditional update).
- **Login anti-abuse:** a wrong password runs a dummy hash so timing never
  reveals whether an account exists, and the generic error never distinguishes
  “no such user” from “wrong password”. Consecutive failures per account trip a
  Redis-backed **lockout** (`LOGIN_MAX_ATTEMPTS`, default 8 → `LOGIN_LOCKOUT_SEC`,
  default 15 min), which holds across instances and can't be dodged by rotating
  IPs. A coarse per-IP **rate limit** sits in front of everything.

## Sessions & tokens

- **Access tokens** are short-lived (15 min) HS256 JWTs with pinned `alg`,
  `iss`/`aud` checks, and a `kind` claim that keeps admin and bidder tokens
  strictly non-interchangeable. They live **only in the SPA's memory** — never
  `localStorage` — so stored-token theft via XSS is off the table.
- **Refresh tokens** are delivered as an **httpOnly, Secure, SameSite=Strict
  cookie** scoped to `/api/auth`, hashed at rest, and **rotated on every use**.
  Because the cookie is SameSite=Strict and only the refresh route reads it,
  the refresh endpoint is inherently CSRF-safe.
- **Theft detection:** presenting an already-rotated refresh token is treated as
  a leak — the entire token family for that user is revoked and the event is
  audited, so a stolen cookie self-limits.
- **Instant revocation:** changing a password, deactivating an account, or
  changing a role revokes all of that user's refresh tokens; the outstanding
  access token then dies on its ≤15-min TTL.

## Authorization

Action-level RBAC (`requirePermission`) over ~30 permissions for the 7 roles,
**deny-by-default**, enforced per route at the API and mirrored (never trusted)
in the UI. The `super_admin` matrix is locked and the last active super admin
can't be demoted or deactivated.

## Transport & headers

`@fastify/helmet` sets HSTS, `X-Content-Type-Options: nosniff`, frameguard
(clickjacking), and a strict referrer policy. **CORS** is an explicit origin
allowlist (`CORS_ORIGINS`) with credentials — never a wildcard.

## Production guards

Booting with `NODE_ENV=production` refuses to start unless `JWT_SECRET` is set
and ≥32 chars and `CORS_ORIGINS` is configured, so a deploy can't fall back to a
source-published secret or a permissive origin.

## Audit

Every sensitive action — logins, lockouts, recovery-code use, refresh-reuse
detection, password changes, role/permission edits — is written to the
append-only `audit_log` with the real actor and a snapshot label.

## Known follow-ups

- Encrypt the TOTP secret column at rest (envelope encryption / KMS); today it
  relies on database-level at-rest encryption.
- Optional WebAuthn/passkey as a phishing-resistant second factor.
- Ship a QR image for TOTP enrollment (the secret + `otpauth://` URI are
  provided today for manual key entry).
