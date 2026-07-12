/**
 * One problem with the current draft, wherever it came from.
 *
 * This lives on its own rather than next to the store because it is the common
 * currency of three layers that otherwise know nothing about each other: the
 * renderer produces them from the driver's info log, the editor renders them as
 * squiggles, and the store is only the place they meet. Hanging the type off
 * the store forced the rendering and editor layers to import the store just to
 * name it.
 */

/** Which buffer a diagnostic belongs to — also the editor tab it shows up in. */
export type DiagnosticSource = 'fragment' | 'vertex' | 'config';

export interface CompileDiagnostic {
  severity: 'error' | 'warning';
  /** 1-based, already mapped back to the user's source. 0 when unknown. */
  line: number;
  message: string;
  source: DiagnosticSource;
}
