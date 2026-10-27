'use client';

import Link from 'next/link';
import { useSession } from '@/components/AuthProvider';
import { getBrand } from '@/lib/brand';
import { itemLabel, visibleApps } from '@/components/nav-config';

// Odoo's home menu: every app as a tile, its main screens one click away.
export default function AppsPage() {
  const brand = getBrand();
  const { data: session } = useSession();
  const { apps } = visibleApps({ role: session?.user?.role || 'STAFF', vertical: brand.vertical, indiaMartEnabled: true });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Apps</h1>
        <p className="text-sm text-muted mt-0.5">Pick an area to work in. The menu on the left then shows only that app.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {apps.map(app => {
          const Icon = app.icon;
          return (
            <section key={app.key} className="glass-card p-4 flex flex-col">
              <Link href={app.items[0].href} className="flex items-center gap-3 group">
                <span className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${app.color}1a` }}>
                  <Icon className="w-5 h-5" style={{ color: app.color }} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground group-hover:text-accent">{app.label}</span>
                  <span className="block text-xs text-muted truncate">{app.description}</span>
                </span>
              </Link>
              <ul className="mt-3 pt-3 border-t border-border grid grid-cols-1 gap-0.5">
                {app.items.slice(0, 6).map(item => (
                  <li key={item.href}>
                    <Link href={item.href} className="block px-2 py-1 -mx-2 rounded-md text-[13px] text-muted hover:text-foreground hover:bg-surface-hover">
                      {itemLabel(item, brand.vertical)}
                    </Link>
                  </li>
                ))}
                {app.items.length > 6 && <li className="px-0 py-1 text-xs text-muted">+{app.items.length - 6} more in the menu</li>}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
