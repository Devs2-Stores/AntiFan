/**
 * Identity-plane cookie names that must never travel over the companion sync
 * channel.
 *
 * An auth cookie is single-owner. IdentityServer4 keeps its browser session in
 * `idsrv` and pairs it with the `idsrv.session` marker, and the ASP.NET Core
 * admin session hangs off that same server-side record. Writing a *second*
 * browser's copy of that pair into a partition that is already signed in does
 * not hand the session over, it splits the pair: the server then sees an
 * `idsrv` it never issued sitting next to the marker it did issue, invalidates
 * the session, and the next navigation lands back on the login page. The
 * companion only re-pushes when its service worker wakes, so the loss shows up
 * minutes later as "logged out again", never as an instant failure.
 *
 * Storefront context is a different kind of data and keeps syncing: cart
 * contents, theme preview and anonymous visit state carry no server-side
 * identity, so a second writer cannot invalidate anything by adding them.
 *
 * Rotating tokens are listed for the same reason, and are why this is not "a
 * Haravan list": a value one client is expected to refresh cannot be copied to
 * a second live client without the two evicting each other.
 *
 * Name-only on purpose. These names are identity markers wherever they appear;
 * it is the platform that defines them, not the host they landed on.
 */
export const IDENTITY_COOKIE_PATTERNS: readonly RegExp[] = [
  // IdentityServer4: idsrv, idsrv.session, idsrv.device, idsrv.external, and the
  // `idsv.device` spelling Haravan actually writes.
  /^ids(v|rv)(\.|$)/i,
  // ASP.NET Core auth and anti-forgery: .AspNetCore.Cookies, .AspNetCore.Antiforgery.*
  /^\.?AspNetCore(\.|$)/i,
  /^__RequestVerificationToken$/i,
  // Platform admin sessions.
  /^_secure_admin_session_id$/i,
  /^sapo_admin_session$/i,
  // Rotating identity tokens.
  /^__Secure-[0-9]?PSIDTS$/i,
  /^__Secure-[0-9]?PSIDRTS$/i,
  /^__Secure-[0-9]?PSIDCC$/i,
];

export function isIdentityCookieName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  for (const pattern of IDENTITY_COOKIE_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}
