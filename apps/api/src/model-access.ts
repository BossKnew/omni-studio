import type { Prisma } from './generated/prisma/client';
import type { AuthUser } from './common';

export function accessibleModelWhere(user: AuthUser): Prisma.ModelWhereInput {
  if (user.role === 'ADMIN') return {};
  return {
    allowedGroups: { some: { groupId: { in: user.groupIds } } },
  };
}

export function canAccessModel(user: AuthUser, allowedGroups?: Array<{ groupId: string }>): boolean {
  if (user.role === 'ADMIN') return true;
  if (!allowedGroups?.length) return false;
  const memberships = new Set(user.groupIds);
  return allowedGroups.some(({ groupId }) => memberships.has(groupId));
}
