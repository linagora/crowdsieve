import { StatusContent } from '@/components/StatusContent';
import { requirePageAuth } from '@/lib/auth/guard';

// Force dynamic rendering to read env vars at runtime
export const dynamic = 'force-dynamic';

export default async function StatusPage() {
  await requirePageAuth();
  return <StatusContent />;
}
