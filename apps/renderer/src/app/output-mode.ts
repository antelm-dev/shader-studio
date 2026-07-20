/**
 * True on the secondary `/output` window, which mirrors the main tab's
 * preview rather than hosting a full editing session — routing, global
 * shortcuts and startup orchestration all skip themselves there.
 */
export function isOutputWindow(): boolean {
  return typeof window !== 'undefined' && window.location.pathname.replace(/\/$/, '') === '/output';
}
