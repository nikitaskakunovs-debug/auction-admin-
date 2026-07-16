/**
 * Hostname-based mode detection. The same SPA build is served on two hosts:
 *   admin.<domain> — the full operations panel
 *   wh.<domain>    — warehouse workers' phone shell, locked to warehouse mode
 * Caddy serves identical files + the same same-origin /api proxy on both, so
 * sessions, RBAC, and cookies all work unchanged per host.
 */

export function isWarehouseHost(): boolean {
  return window.location.hostname.startsWith("wh.");
}

/** The full-admin origin, reachable from the warehouse host. */
export function adminOrigin(): string {
  return window.location.origin.replace("//wh.", "//admin.");
}
