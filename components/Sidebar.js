'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { ChevronLeft, ChevronRight, ChevronDown, X } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useSession } from '@/components/AuthProvider';
import { useSidebarContext } from './SidebarContext';
import { getStoreSettings } from '@/app/actions/settings';
import { getIndiaMartConfig } from '@/app/actions/indiamart';
import { getBrand } from '@/lib/brand';
import { isRouteActive, itemLabel, visibleApps } from './nav-config';

export default function Sidebar() {
  const pathname = usePathname();
  const brand = getBrand();
  const { sidebarOpen, setSidebarOpen, collapsed, setCollapsed } = useSidebarContext();
  const { data: session } = useSession();

  const [logoUrl, setLogoUrl] = useState(brand.logo);
  const [indiaMartEnabled, setIndiaMartEnabled] = useState(false);
  // An app opened or closed by hand on this page; after navigating, the app
  // of the current page is the open one again.
  const [manual, setManual] = useState({ path: null, key: null });
  const openApp = manual.path === pathname ? manual.key : null;
  const setOpenApp = key => setManual({ path: pathname, key });

  useEffect(() => {
    getStoreSettings().then(res => {
      if (res.success && res.data.logo) setLogoUrl(res.data.logo);
    });
    getIndiaMartConfig().then(res => {
      if (res.success) setIndiaMartEnabled(!!res.data.enabled);
    });
    const handleLogoUpdate = (e) => setLogoUrl(e.detail);
    window.addEventListener('logo-updated', handleLogoUpdate);
    return () => window.removeEventListener('logo-updated', handleLogoUpdate);
  }, []);

  const userRole = session?.user?.role || 'STAFF';
  const userName = session?.user?.name || 'User';
  const userInitials = userName.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
  const roleLabel = userRole === 'ADMIN' ? 'Administrator' : userRole === 'MANAGER' ? 'Manager' : 'Staff';

  const { home, apps } = visibleApps({ role: userRole, vertical: brand.vertical, indiaMartEnabled });
  const currentApp = apps.find(app => app.items.some(item => isRouteActive(pathname, item.href)))?.key ?? null;
  const expanded = openApp ?? currentApp;
  const iconOnly = collapsed && !sidebarOpen;

  const linkClass = (active) => `flex items-center gap-2.5 rounded-md text-[13px] transition-colors ${active
    ? 'bg-sidebar-active text-accent font-medium'
    : 'text-muted hover:text-foreground hover:bg-surface-hover'}`;

  return (
    <>
      {/* Mobile overlay backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-[55] md:hidden animate-[fade-in_0.2s_ease]"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`
          fixed top-0 left-0 h-screen bg-sidebar border-r border-border flex flex-col z-[60] transition-all duration-300
          max-md:w-[272px]
          ${sidebarOpen ? 'max-md:translate-x-0' : 'max-md:translate-x-[-100%]'}
          ${collapsed ? 'md:w-[64px]' : 'md:w-[240px]'}
        `}
      >
        {/* Logo */}
        <div className="flex items-center justify-between px-4 h-14 border-b border-border flex-shrink-0">
          <Link href="/apps" className="flex items-center gap-2.5 min-w-0" title="All apps" onClick={() => setSidebarOpen(false)}>
            {/* The bundled default logo is white-on-transparent; until the store
                uploads its own logo (Settings), show a monogram that reads on any theme. */}
            {logoUrl && logoUrl !== brand.logo ? (
              <div className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 overflow-hidden">
                <Image src={logoUrl} alt={`${brand.name} Logo`} width={28} height={28} className="object-contain" priority />
              </div>
            ) : (
              <div className="w-7 h-7 rounded-md bg-accent text-white flex items-center justify-center flex-shrink-0 text-sm font-semibold" aria-hidden>
                {brand.name.charAt(0)}
              </div>
            )}
            {!iconOnly && (
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">{brand.name}</p>
                <p className="text-[11px] text-muted">{roleLabel}</p>
              </div>
            )}
          </Link>
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden p-1.5 rounded-md text-muted hover:text-foreground hover:bg-surface-hover"
            aria-label="Close menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 py-2 px-2 overflow-y-auto">
          {home.map(item => {
            const Icon = item.icon;
            const active = isRouteActive(pathname, item.href);
            return (
              <Link key={item.href} href={item.href} onClick={() => setSidebarOpen(false)} title={iconOnly ? item.label : undefined}
                className={`${linkClass(active)} px-2.5 py-1.5 ${iconOnly ? 'justify-center' : ''}`}>
                <Icon className="w-4 h-4 flex-shrink-0" />
                {!iconOnly && <span>{item.label}</span>}
              </Link>
            );
          })}

          <div className="my-2 border-t border-border" />

          {apps.map(app => {
            const AppIcon = app.icon;
            const isOpen = expanded === app.key;
            const isCurrent = currentApp === app.key;
            if (iconOnly) {
              return (
                <Link key={app.key} href={app.items[0].href} title={app.label}
                  className={`flex items-center justify-center py-2 rounded-md ${isCurrent ? 'bg-sidebar-active' : 'hover:bg-surface-hover'}`}>
                  <AppIcon className="w-[18px] h-[18px]" style={{ color: app.color }} />
                </Link>
              );
            }
            return (
              <div key={app.key} className="mb-0.5">
                <button
                  type="button"
                  onClick={() => setOpenApp(isOpen ? '' : app.key)}
                  aria-expanded={isOpen}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] font-medium transition-colors ${isCurrent ? 'text-foreground' : 'text-foreground/80 hover:bg-surface-hover'}`}
                >
                  <span className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${app.color}1a` }}>
                    <AppIcon className="w-[15px] h-[15px]" style={{ color: app.color }} />
                  </span>
                  <span className="flex-1 text-left">{app.label}</span>
                  <ChevronDown className={`w-3.5 h-3.5 text-muted transition-transform ${isOpen ? '' : '-rotate-90'}`} />
                </button>
                {isOpen && (
                  <div className="ml-[22px] pl-3 border-l border-border space-y-px py-0.5">
                    {app.items.map(item => {
                      const active = isRouteActive(pathname, item.href);
                      return (
                        <Link key={item.href} href={item.href} onClick={() => setSidebarOpen(false)} className={`${linkClass(active)} px-2.5 py-1.5`}>
                          {itemLabel(item, brand.vertical)}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* User section (mobile only) */}
        <div className="md:hidden px-4 py-3 border-t border-border">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-accent text-white flex items-center justify-center text-xs font-semibold">
              {userInitials}
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">{userName}</p>
              <p className="text-[11px] text-muted">{roleLabel}</p>
            </div>
          </div>
        </div>

        {/* Collapse toggle (desktop only) */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="hidden md:flex mx-2 mb-3 p-1.5 rounded-md border border-border text-muted hover:text-foreground hover:bg-surface-hover items-center justify-center"
          aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </aside>
    </>
  );
}

export function useSidebarWidth() {
  return 240;
}
