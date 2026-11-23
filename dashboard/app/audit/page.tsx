import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { AuditLogContent } from '@/components/AuditLogContent';
import { requirePageAuth } from '@/lib/auth/guard';

// Force dynamic rendering: the session is checked on every request.
export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  await requirePageAuth();

  return (
    <Suspense
      fallback={
        <div className="card p-6">
          <div className="flex items-center justify-center py-8 text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Loading...
          </div>
        </div>
      }
    >
      <AuditLogContent />
    </Suspense>
  );
}
