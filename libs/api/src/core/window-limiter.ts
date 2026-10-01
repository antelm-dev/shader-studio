/**
 * A fixed-window count per address. The whole map is dropped when the window
 * rolls over, so it never holds more than one window's callers.
 */
// ponytail: per-process; a multi-instance deployment needs a shared store here.
export function windowLimiter(windowMs: number, max: number): (key: string) => boolean {
  const hits = new Map<string, number>();
  let resetAt = 0;
  return (key) => {
    const now = Date.now();
    if (now >= resetAt) {
      hits.clear();
      resetAt = now + windowMs;
    }
    const count = (hits.get(key) ?? 0) + 1;
    hits.set(key, count);
    return count <= max;
  };
}
