'use client';

import { createContext, useContext } from 'react';
import type { UserRole } from '@/lib/auth/roles';

/**
 * Role of the current user for client components, resolved on the server by
 * the root layout (`getSessionRole()`). It only decides which controls are
 * rendered: the write routes check the role again (`requireOperator()`).
 * Defaults to 'viewer' so that a component rendered outside the provider
 * shows no write control.
 */
const UserRoleContext = createContext<UserRole>('viewer');

export function UserRoleProvider({
  role,
  children,
}: {
  role: UserRole;
  children: React.ReactNode;
}) {
  return <UserRoleContext.Provider value={role}>{children}</UserRoleContext.Provider>;
}

export function useUserRole(): UserRole {
  return useContext(UserRoleContext);
}

/** Whether the current user may ban, unban and run analyzers. */
export function useCanWrite(): boolean {
  return useUserRole() === 'operator';
}
