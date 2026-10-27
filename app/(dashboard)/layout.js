import SidebarClient from '@/components/SidebarClient';
import TopBar from '@/components/TopBar';
import { SidebarProvider, SidebarOffset } from '@/components/SidebarContext';

export default function DashboardLayout({ children }) {
  return (
    <SidebarProvider>
      <div className="flex min-h-screen bg-background">
        <SidebarClient />
        <SidebarOffset>
          <TopBar />
          <main className="p-3.5 md:p-6 overflow-x-hidden pt-5 md:pt-6 max-w-[1600px]">
            {children}
          </main>
        </SidebarOffset>
      </div>
    </SidebarProvider>
  );
}
