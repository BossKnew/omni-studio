type AssetLinksInput = {
  id: string;
  deletedAt?: Date | null;
  purgedAt?: Date | null;
  contentHash?: string | null;
  thumbnail?: {
    id: string;
    deletedAt: Date | null;
    purgedAt?: Date | null;
    contentHash?: string | null;
    width?: number | null;
    height?: number | null;
  } | null;
};

export function assetContentUrl(id: string, contentHash?: string | null) {
  const path = `/api/v1/assets/${id}/content`;
  return contentHash ? `${path}?v=${contentHash.slice(0, 16)}` : path;
}

export function mediaCacheControl(contentHash?: string | null) {
  return contentHash ? 'private, max-age=31536000, immutable' : 'private, max-age=3600';
}

export function mediaEtag(asset: { id: string; sizeBytes: bigint; contentHash?: string | null }) {
  return `"${asset.contentHash || `${asset.id}-${asset.sizeBytes.toString()}`}"`;
}

export function ifNoneMatchHits(header: unknown, etag: string) {
  if (typeof header !== 'string') return false;
  return header.split(',').some((tag) => {
    const value = tag.trim();
    return value === etag || value === `W/${etag}`;
  });
}

export function serializeAssetLinks(asset: AssetLinksInput, options?: { allowTrash?: boolean }) {
  if (asset.purgedAt || (asset.deletedAt && !options?.allowTrash)) {
    return { deleted: true, contentUrl: null, thumbnailUrl: null, thumbnailWidth: null, thumbnailHeight: null };
  }
  const thumbnail = asset.thumbnail && !asset.thumbnail.purgedAt && (!asset.thumbnail.deletedAt || options?.allowTrash) ? asset.thumbnail : null;
  return {
    deleted: false,
    contentUrl: assetContentUrl(asset.id, asset.contentHash),
    thumbnailUrl: thumbnail ? assetContentUrl(thumbnail.id, thumbnail.contentHash) : null,
    thumbnailWidth: thumbnail?.width ?? null,
    thumbnailHeight: thumbnail?.height ?? null,
  };
}
