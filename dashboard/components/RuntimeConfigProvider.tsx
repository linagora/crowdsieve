'use client';

import { createContext, useContext } from 'react';
import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from '@/lib/runtimeConfig';

const RuntimeConfigContext = createContext<RuntimeConfig>(DEFAULT_RUNTIME_CONFIG);

export function RuntimeConfigProvider({
  config,
  children,
}: {
  config: RuntimeConfig;
  children: React.ReactNode;
}) {
  return <RuntimeConfigContext.Provider value={config}>{children}</RuntimeConfigContext.Provider>;
}

export function useRuntimeConfig(): RuntimeConfig {
  return useContext(RuntimeConfigContext);
}
