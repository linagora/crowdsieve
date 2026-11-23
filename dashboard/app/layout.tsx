import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Header } from '@/components/Header';
import { RuntimeConfigProvider } from '@/components/RuntimeConfigProvider';
import { UserRoleProvider } from '@/components/UserRoleProvider';
import { StatusBanner } from '@/components/StatusBanner';
import { getRuntimeConfig } from '@/lib/runtimeConfig';
import { getSessionRole } from '@/lib/oidc/session';
import type { UserRole } from '@/lib/auth/roles';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'CrowdSieve Dashboard',
  description: 'Monitor and visualize CrowdSec alerts',
};

// Runtime settings (CTI_LINKS_ENABLED...) and the user's role are read per
// request, not at build time.
export const dynamic = 'force-dynamic';

/** Role that decides which write controls are rendered (see UserRoleProvider). */
async function resolveRole(): Promise<UserRole> {
  try {
    return await getSessionRole();
  } catch {
    return 'viewer';
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const role = await resolveRole();
  return (
    <html lang="en">
      <body className={inter.className}>
        <RuntimeConfigProvider config={getRuntimeConfig()}>
          <UserRoleProvider role={role}>
            <div className="min-h-screen">
              <Header />
              <StatusBanner />
              <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
            </div>
          </UserRoleProvider>
        </RuntimeConfigProvider>
      </body>
    </html>
  );
}
