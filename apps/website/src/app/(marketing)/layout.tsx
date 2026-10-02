import type { ReactNode } from 'react';

import { GroveProvider } from '@/components/grove/grove-provider';
import { SiteFooter } from '@/components/site/site-footer';
import { SiteHeader } from '@/components/site/site-header';

/** Marketing pages share the header, footer and the grove's palette state. */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <GroveProvider>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="shell">
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
      </div>
    </GroveProvider>
  );
}
