import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'Shadergrove — A little code. A living world.',
  description:
    'A little code. A living world. Shadergrove is your workspace for writing, tuning, and collecting real-time shaders.',
  // Generated from the brand geometry by app/icon.svg/route.ts.
  icons: { icon: [{ url: '/icon.svg', type: 'image/svg+xml' }] },
};

export const viewport: Viewport = {
  themeColor: '#10130f',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
