'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCcw } from 'lucide-react';

// Shown inside the dashboard layout (sidebar and top bar stay) when a page
// throws while rendering or loading data, instead of a blank or frozen screen.
export default function DashboardError({ error, reset }) {
  useEffect(() => {
    console.error('Dashboard page failed:', error);
  }, [error]);

  return (
    <div className="max-w-lg mx-auto mt-16 p-6 rounded-2xl border border-red-500/20 bg-red-500/5 text-center space-y-3">
      <AlertTriangle className="w-8 h-8 text-red-600 mx-auto" />
      <h2 className="text-lg font-semibold text-foreground">This page could not load</h2>
      <p className="text-sm text-muted">
        Something went wrong while showing this screen. Your data is safe. Try again, or go back to the dashboard.
      </p>
      {error?.digest && <p className="text-[11px] text-muted font-mono">Reference: {error.digest}</p>}
      <div className="flex justify-center gap-2 pt-2">
        <button onClick={() => reset()} className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-xl text-sm font-medium hover:bg-accent-hover transition-colors">
          <RotateCcw className="w-4 h-4" /> Try again
        </button>
        <Link href="/" className="px-4 py-2 bg-surface border border-border text-muted rounded-xl text-sm font-medium hover:text-accent transition-colors">
          Dashboard
        </Link>
      </div>
    </div>
  );
}
