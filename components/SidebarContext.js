'use client';

import { createContext, useContext, useState } from 'react';

const SidebarContext = createContext();

export function SidebarProvider({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <SidebarContext.Provider value={{ sidebarOpen, setSidebarOpen, collapsed, setCollapsed }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebarContext() {
  return useContext(SidebarContext);
}

// Page column that follows the desktop sidebar width (full / icons only).
export function SidebarOffset({ children }) {
  const { collapsed } = useSidebarContext();
  return (
    <div className={`flex-1 ml-0 min-w-0 transition-all duration-300 ${collapsed ? 'md:ml-[64px]' : 'md:ml-[240px]'}`}>
      {children}
    </div>
  );
}
