import { Inter, Roboto_Mono } from 'next/font/google';
import './globals.css';
import AuthProvider from '@/components/AuthProvider';
import AlertToastProvider from '@/components/AlertToastProvider';
import { getBrand } from '@/lib/brand';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const robotoMono = Roboto_Mono({ subsets: ['latin'], variable: '--font-roboto-mono', weight: ['400', '500'] });

export function generateMetadata() {
  const brand = getBrand();
  return {
    title: brand.title,
    description: brand.description,
    icons: { icon: brand.favicon },
  };
}

export default function RootLayout({ children }) {
  const brand = getBrand();
  return (
    // Font variables live on <html> because --font-sans (declared on :root) refers to them.
    <html lang="en" data-brand={brand.brandAttribute ?? undefined} className={`${inter.variable} ${robotoMono.variable}`} suppressHydrationWarning>
      <body suppressHydrationWarning className="font-sans antialiased">
        <AuthProvider>
          <AlertToastProvider>
            {children}
          </AlertToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
