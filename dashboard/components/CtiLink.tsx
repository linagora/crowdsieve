'use client';

import { isPublicIp, ctiUrl } from '@/lib/publicIp';
import { useRuntimeConfig } from '@/components/RuntimeConfigProvider';

interface CtiLinkProps {
  /** Value to look up; nothing is rendered unless it is a single public IP. */
  ip: string | null | undefined;
  className?: string;
}

/**
 * "CrowdSec CTI" external link for a single public IP address. Renders
 * nothing for ranges, private/loopback/link-local addresses, or when
 * `CTI_LINKS_ENABLED=false`.
 */
export function CtiLink({ ip, className }: CtiLinkProps) {
  const { ctiLinksEnabled } = useRuntimeConfig();
  if (!ctiLinksEnabled || !ip || !isPublicIp(ip)) return null;

  return (
    <a
      href={ctiUrl(ip)}
      target="_blank"
      rel="noopener noreferrer"
      title="Open this IP's reputation on CrowdSec CTI (external site)"
      className={
        className ??
        'text-xs px-2 py-1 border border-crowdsec-primary text-crowdsec-primary rounded hover:bg-slate-50 transition-colors'
      }
    >
      CrowdSec CTI ↗
    </a>
  );
}
