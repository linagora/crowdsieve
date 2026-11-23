'use client';

import { Lock } from 'lucide-react';
import { BanIPForm } from '@/components/BanIPForm';
import { useCanWrite } from '@/components/UserRoleProvider';

/** Text shown to read-only users in place of the Manual Ban form. */
export const READ_ONLY_BAN_NOTICE = 'Read-only access: ask an operator to ban an IP';

/** The Manual Ban card for Operators, a one-line note for Viewers. */
export function ManualBan({ initialIp }: { initialIp?: string }) {
  const canWrite = useCanWrite();
  if (canWrite) return <BanIPForm initialIp={initialIp} />;
  return (
    <div className="card p-4 flex items-center gap-2 text-sm text-slate-600">
      <Lock className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>{READ_ONLY_BAN_NOTICE}</span>
    </div>
  );
}
