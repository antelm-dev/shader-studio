'use client';

import { useGrove } from '@/components/grove/grove-provider';

/** The selected palette, announced when it changes. */
export function PaletteCaption() {
  const { palette, mono } = useGrove();
  return (
    <span aria-live="polite">
      {palette.number} / {palette.name}
      {mono ? ' · Mono' : ''}
    </span>
  );
}
