/** One row of the command palette: a command, or a shader to open. */
export interface PaletteItem {
  readonly id: string;
  readonly icon: string;
  readonly label: string;
  /** The heading the row is listed under while nothing is being searched. */
  readonly group: string;
  readonly shortcut?: string;
  readonly disabled?: boolean;
  readonly run: () => void;
}

/** Lower-cased and stripped of accents, so "prereglage" finds "Préréglage". */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * The items a query keeps, best match first.
 *
 * Every word of the query has to appear in the label. A label that starts with
 * the query outranks one where a word starts with it, which outranks a match in
 * the middle of a word; ties keep the order the items came in, so the commands
 * stay in menu order. An empty query keeps everything, untouched.
 */
export function searchPalette(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...items];

  const needle = terms.join(' ');
  const ranked: { item: PaletteItem; rank: number; index: number }[] = [];

  items.forEach((item, index) => {
    const label = fold(item.label);
    if (!terms.every((term) => label.includes(term))) return;

    const words = label.split(/[^\p{L}\p{N}]+/u);
    const rank = label.startsWith(needle)
      ? 0
      : terms.every((term) => words.some((word) => word.startsWith(term)))
        ? 1
        : 2;
    ranked.push({ item, rank, index });
  });

  return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ item }) => item);
}
