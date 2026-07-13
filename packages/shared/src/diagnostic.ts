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

/**
 * Which shader stage a diagnostic came out of.
 *
 * This is *not* the same question as which file it belongs to, and conflating
 * them is what breaks the moment a project has more than one pass: every buffer
 * has a fragment stage, so `fragment` no longer identifies anything. `docId`
 * answers the second question.
 */
export type DiagnosticSource = 'fragment' | 'vertex' | 'config';

/**
 * The two documents that are not passes or files. They are ids in the same
 * namespace as pass and file ids, so that everything the editor can open — and
 * everything a diagnostic can point at — is addressed the same way.
 */
export const VERTEX_DOC = '@vertex';
export const CONFIG_DOC = '@config';

export interface CompileDiagnostic {
  severity: 'error' | 'warning';
  /** 1-based, already mapped back to the user's source. 0 when unknown. */
  line: number;
  message: string;
  source: DiagnosticSource;
  /**
   * The editor document this belongs to: a pass, an included file, `@vertex` or
   * `@config`. Already mapped back through the composition, so an error the
   * driver reported inside the Common pass says Common — not the pass that
   * happened to include it.
   *
   * Optional only because a diagnostic can be raised before there is a project
   * to attribute it to; the editor treats a missing one as "the open tab".
   */
  docId?: string;
  /** The document's name, so a diagnostic reads correctly on its own. */
  docName?: string;
}
