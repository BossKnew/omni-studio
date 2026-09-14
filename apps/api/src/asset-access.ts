import type { Prisma } from './generated/prisma/client';
import type { AuthUser } from './common';

const LIBRARY_ROLES = ['UPLOAD', 'OUTPUT'] as const;

export type AssetShareTeam = { teamId: string };

export type AssetAccessView = {
  userId: string;
  role: string;
  deletedAt?: Date | null;
  purgedAt?: Date | null;
  shares?: AssetShareTeam[] | null;
  thumbnailFor?: {
    userId: string;
    role: string;
    deletedAt?: Date | null;
    purgedAt?: Date | null;
    shares?: AssetShareTeam[] | null;
  } | null;
};

export function sharedToViewerWhere(user: AuthUser): Prisma.AssetShareWhereInput {
  if (user.role === 'ADMIN') return {};
  return { teamId: { in: user.teamIds } };
}

export function accessibleSourceWhere(user: AuthUser): Prisma.AssetWhereInput {
  return {
    deletedAt: null,
    role: { in: [...LIBRARY_ROLES] },
    OR: [
      { userId: user.id },
      { shares: { some: sharedToViewerWhere(user) } },
    ],
  };
}

export function accessibleReferencedAssetWhere(user: AuthUser): Prisma.AssetWhereInput {
  return {
    deletedAt: null,
    OR: [
      { userId: user.id },
      {
        role: { in: [...LIBRARY_ROLES] },
        shares: { some: sharedToViewerWhere(user) },
      },
    ],
  };
}

function libraryTarget(asset: AssetAccessView) {
  if (asset.role === 'THUMBNAIL') return asset.thumbnailFor ?? null;
  return asset;
}

function hasShareAccess(user: AuthUser, shares: AssetShareTeam[] | null | undefined) {
  if (!shares?.length) return false;
  if (user.role === 'ADMIN') return true;
  const teams = new Set(user.teamIds);
  return shares.some(({ teamId }) => teams.has(teamId));
}

function isPurged(asset: { purgedAt?: Date | null } | null | undefined) {
  return Boolean(asset?.purgedAt);
}

export function canReadAsset(user: AuthUser, asset: AssetAccessView | null | undefined) {
  if (!asset || isPurged(asset)) return false;
  const target = libraryTarget(asset);
  if (isPurged(target)) return false;
  const trashed = Boolean(asset.deletedAt || target?.deletedAt);
  if (trashed) return asset.userId === user.id;
  if (asset.userId === user.id) return true;
  if (!target) return false;
  if (target.userId === user.id) return true;
  if (target.role !== 'UPLOAD' && target.role !== 'OUTPUT') return false;
  return hasShareAccess(user, target.shares ?? (target === asset ? asset.shares : null));
}

export function canShareAsset(user: AuthUser, asset: { userId: string; role: string; deletedAt?: Date | null } | null | undefined) {
  return Boolean(asset && !asset.deletedAt && asset.userId === user.id && (asset.role === 'UPLOAD' || asset.role === 'OUTPUT'));
}

export function canUnshareAsset(user: AuthUser, asset: { userId: string; deletedAt?: Date | null } | null | undefined) {
  if (!asset || asset.deletedAt) return false;
  return asset.userId === user.id || user.role === 'ADMIN';
}
