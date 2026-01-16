import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Header } from '@/components/Header';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'CrowdSieve Dashboard',
  description: 'Monitor and visualize CrowdSec alerts',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <div className="min-h-screen">
          <Header />
          <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
