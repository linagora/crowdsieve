import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
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
          <header className="bg-crowdsec-primary text-white">
            <div className="max-w-7xl mx-auto px-4 py-4">
              <div className="flex items-center justify-between">
                <h1 className="text-xl font-bold">CrowdSieve</h1>
                <nav className="flex gap-4">
                  <a href="/" className="hover:text-crowdsec-accent transition-colors">
                    Dashboard
                  </a>
                  <a href="/alerts" className="hover:text-crowdsec-accent transition-colors">
                    Alerts
                  </a>
                </nav>
              </div>
            </div>
          </header>
          <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
