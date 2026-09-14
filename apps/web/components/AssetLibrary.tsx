import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { api, json } from '@/lib/api';
import { downloadFiles, extensionForMime } from '@/lib/download';
import { EMPTY_ASSET_FILTERS, activeAssetFilterCount, hasActiveAssetFilters, isInvertedDateRange, toAssetQuery, type AssetLibraryFilters } from '@/lib/asset-query';
import type { Asset, CursorPage, StudioModel, StudioTeam } from '@/lib/studio-types';
import { useI18n } from '@/lib/i18n';
import Icon from '@/components/Icon';
import Toast, { useToast } from '@/components/Toast';

type LibraryTab = 'mine' | 'shared' | 'trash';

type AssetLibraryProps = {
  models: StudioModel[];
  libraryEpoch: number;
  onStartCreation: () => void;
  onOpenAsset: (asset: Asset) => void;
  onUseAsReference: (asset: Asset) => void;
  onAssetNoteSaved: (id: string, note: string | null) => void;
  onAssetDeleted: (asset: Asset) => void;
  onAssetRestored: (asset: Asset) => void;
  isAdmin: boolean;
};

export default function AssetLibrary({
  models, libraryEpoch, onStartCreation, onOpenAsset, onUseAsReference, onAssetNoteSaved, onAssetDeleted, onAssetRestored, isAdmin,
}: AssetLibraryProps) {
  const { t, locale } = useI18n();
  const { toast, showToast } = useToast();
  const [tab, setTab] = useState<LibraryTab>('mine');
  const [filters, setFilters] = useState<AssetLibraryFilters>({ ...EMPTY_ASSET_FILTERS });
  const [qDraft, setQDraft] = useState('');
  const [teams, setTeams] = useState<StudioTeam[]>([]);
  const [teamId, setTeamId] = useState('');
  const [mineAssets, setMineAssets] = useState<Asset[]>([]);
  const [mineCursor, setMineCursor] = useState<string | null>(null);
  const [mineTotal, setMineTotal] = useState(0);
  const [mineLoading, setMineLoading] = useState(false);
  const [sharedAssets, setSharedAssets] = useState<Asset[]>([]);
  const [sharedCursor, setSharedCursor] = useState<string | null>(null);
  const [sharedTotal, setSharedTotal] = useState(0);
  const [sharedLoading, setSharedLoading] = useState(false);
  const [trashAssets, setTrashAssets] = useState<Asset[]>([]);
  const [trashCursor, setTrashCursor] = useState<string | null>(null);
  const [trashTotal, setTrashTotal] = useState(0);
  const [trashLoading, setTrashLoading] = useState(false);
  const [emptyingTrash, setEmptyingTrash] = useState(false);
  const [noteAsset, setNoteAsset] = useState<Asset | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState('');
  const [sharingAsset, setSharingAsset] = useState<Asset | null>(null);
  const [shareDraft, setShareDraft] = useState<string[]>([]);
  const [shareBusy, setShareBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [error, setError] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterMenuStyle, setFilterMenuStyle] = useState<CSSProperties>({});
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const loadRevision = useRef(0);
  const latest = useRef({ tab, teamId, filters, mineCursor, sharedCursor, trashCursor, isAdmin });
  latest.current = { tab, teamId, filters, mineCursor, sharedCursor, trashCursor, isAdmin };

  const items = tab === 'mine' ? mineAssets : tab === 'shared' ? sharedAssets : trashAssets;
  const total = tab === 'mine' ? mineTotal : tab === 'shared' ? sharedTotal : trashTotal;
  const hasMore = tab === 'mine' ? Boolean(mineCursor) : tab === 'shared' ? Boolean(sharedCursor) : Boolean(trashCursor);
  const loading = tab === 'mine' ? mineLoading : tab === 'shared' ? sharedLoading : trashLoading;
  const canShare = teams.length > 0;
  const visibleFilters = { ...filters, q: tab === 'shared' ? '' : filters.q };
  const filtering = hasActiveAssetFilters(visibleFilters);
  const filterCount = activeAssetFilterCount(visibleFilters);
  const modelOptions = models.filter((model) => filters.mediaKind === 'ALL' || model.mediaKind === filters.mediaKind);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [mineAssets, sharedAssets, trashAssets, tab]);

  useEffect(() => {
    api<StudioTeam[]>('/teams').then(setTeams).catch((caught) => setError(t((caught as Error).message)));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((current) => current.q === qDraft.trim() ? current : { ...current, q: qDraft.trim() });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [qDraft]);

  useEffect(() => {
    void loadPage(true);
  }, [tab, teamId, libraryEpoch, filters.mediaKind, filters.role, filters.q, filters.from, filters.to, filters.modelId]);

  useLayoutEffect(() => {
    if (!filterOpen || !filterTriggerRef.current) return;
    const place = () => {
      const rect = filterTriggerRef.current!.getBoundingClientRect();
      const width = Math.min(440, Math.max(280, window.innerWidth - 16));
      const left = Math.min(rect.left, Math.max(8, window.innerWidth - width - 8));
      setFilterMenuStyle({ top: rect.bottom + 8, left, width });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [filterOpen]);

  useEffect(() => {
    if (!filterOpen && !noteAsset) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (noteAsset) { closeNote(); return; }
      setFilterOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [filterOpen, noteAsset, noteBusy]);

  async function loadPage(reset: boolean) {
    const snapshot = latest.current;
    const revision = reset ? ++loadRevision.current : loadRevision.current;
    if (isInvertedDateRange(snapshot.filters.from, snapshot.filters.to)) {
      setError(t('起始日期必须早于结束日期'));
      if (snapshot.tab === 'mine') {
        setMineAssets([]);
        setMineCursor(null);
        setMineTotal(0);
        setMineLoading(false);
      } else if (snapshot.tab === 'shared') {
        setSharedAssets([]);
        setSharedCursor(null);
        setSharedTotal(0);
        setSharedLoading(false);
      } else {
        setTrashAssets([]);
        setTrashCursor(null);
        setTrashTotal(0);
        setTrashLoading(false);
      }
      return;
    }
    if (snapshot.tab === 'shared' && snapshot.isAdmin && !snapshot.teamId) {
      setSharedAssets([]);
      setSharedCursor(null);
      setSharedTotal(0);
      setSharedLoading(false);
      return;
    }
    const query = toAssetQuery(snapshot.filters, {
      includeQ: snapshot.tab !== 'shared',
      teamId: snapshot.tab === 'shared' ? snapshot.teamId || undefined : undefined,
      cursor: reset ? undefined : (snapshot.tab === 'mine' ? snapshot.mineCursor ?? undefined : snapshot.tab === 'shared' ? snapshot.sharedCursor ?? undefined : snapshot.trashCursor ?? undefined),
    });
    const path = snapshot.tab === 'mine' ? '/assets' : snapshot.tab === 'shared' ? '/assets/shared' : '/assets/trash';
    if (snapshot.tab === 'mine') setMineLoading(true);
    else if (snapshot.tab === 'shared') setSharedLoading(true);
    else setTrashLoading(true);
    setError('');
    try {
      const page = await api<CursorPage<Asset>>(path + (query ? '?' + query : ''));
      if (revision !== loadRevision.current) return;
      if (snapshot.tab === 'mine') {
        setMineAssets((current) => reset ? page.items : [...current, ...page.items]);
        setMineCursor(page.nextCursor);
        if (reset) setMineTotal(page.total ?? page.items.length);
        else if (typeof page.total === 'number') setMineTotal(page.total);
      } else if (snapshot.tab === 'shared') {
        setSharedAssets((current) => reset ? page.items : [...current, ...page.items]);
        setSharedCursor(page.nextCursor);
        if (reset) setSharedTotal(page.total ?? page.items.length);
        else if (typeof page.total === 'number') setSharedTotal(page.total);
      } else {
        setTrashAssets((current) => reset ? page.items : [...current, ...page.items]);
        setTrashCursor(page.nextCursor);
        if (reset) setTrashTotal(page.total ?? page.items.length);
        else if (typeof page.total === 'number') setTrashTotal(page.total);
      }
    } catch (caught) {
      if (revision !== loadRevision.current) return;
      setError(t((caught as Error).message));
    } finally {
      if (revision === loadRevision.current) {
        if (snapshot.tab === 'mine') setMineLoading(false);
        else if (snapshot.tab === 'shared') setSharedLoading(false);
        else setTrashLoading(false);
      }
    }
  }

  function patchFilter<K extends keyof AssetLibraryFilters>(key: K, value: AssetLibraryFilters[K]) {
    setFilters((current) => {
      const next = { ...current, [key]: value };
      if (key === 'role' && value === 'UPLOAD') next.modelId = '';
      if (key === 'mediaKind' && next.modelId) {
        const selected = models.find((model) => model.id === next.modelId);
        if (selected && value !== 'ALL' && selected.mediaKind !== value) next.modelId = '';
      }
      return next;
    });
  }

  function clearFilters() {
    setFilters({ ...EMPTY_ASSET_FILTERS });
    setQDraft('');
  }

  function beginNote(asset: Asset) {
    setNoteAsset(asset);
    setNoteDraft(asset.note ?? '');
    setNoteError('');
  }

  function closeNote() {
    if (noteBusy) return;
    setNoteAsset(null);
    setNoteDraft('');
    setNoteError('');
  }

  async function saveNote() {
    if (!noteAsset) return;
    setNoteBusy(true);
    setNoteError('');
    try {
      const updated = await api<{ id: string; note: string | null }>('/assets/' + noteAsset.id, json('PATCH', { note: noteDraft }));
      setMineAssets((current) => current.map((item) => item.id === noteAsset.id ? { ...item, note: updated.note } : item));
      onAssetNoteSaved(noteAsset.id, updated.note);
      setNoteAsset(null);
      setNoteDraft('');
    } catch (caught) {
      setNoteError(t((caught as Error).message));
    } finally {
      setNoteBusy(false);
    }
  }

  async function deleteAsset(asset: Asset) {
    if (!confirm(t('确定把这项资产移入回收站？可在留存期内恢复。已分享到团队的图片会暂时从团队库消失。'))) return;
    setError('');
    try {
      await api('/assets/' + asset.id, json('DELETE'));
      setSelectedIds((current) => { const next = new Set(current); next.delete(asset.id); return next; });
      setMineAssets((current) => current.filter((item) => item.id !== asset.id));
      setMineTotal((count) => Math.max(0, count - 1));
      onAssetDeleted(asset);
      showToast('success', t('已移入回收站'));
    } catch (caught) {
      setError(t((caught as Error).message));
    }
  }

  async function restoreAsset(asset: Asset) {
    setError('');
    try {
      await api('/assets/' + asset.id + '/restore', json('POST'));
      setSelectedIds((current) => { const next = new Set(current); next.delete(asset.id); return next; });
      setTrashAssets((current) => current.filter((item) => item.id !== asset.id));
      setTrashTotal((count) => Math.max(0, count - 1));
      onAssetRestored(asset);
      showToast('success', t('已恢复'));
    } catch (caught) {
      showToast('error', t((caught as Error).message));
    }
  }

  async function purgeAsset(asset: Asset) {
    if (!confirm(t('确定永久删除这项资产？文件将无法恢复。'))) return;
    setError('');
    try {
      await api('/assets/' + asset.id + '/purge', json('POST'));
      setSelectedIds((current) => { const next = new Set(current); next.delete(asset.id); return next; });
      setTrashAssets((current) => current.filter((item) => item.id !== asset.id));
      setTrashTotal((count) => Math.max(0, count - 1));
      showToast('success', t('已永久删除'));
    } catch (caught) {
      showToast('error', t((caught as Error).message));
    }
  }

  async function emptyTrash() {
    if (!trashTotal) return;
    if (!confirm(t('确定清空回收站？其中的文件将永久删除，无法恢复。'))) return;
    setEmptyingTrash(true);
    setError('');
    try {
      await api('/assets/trash/empty', json('POST'));
      setSelectedIds(new Set());
      setTrashAssets([]);
      setTrashCursor(null);
      setTrashTotal(0);
      showToast('success', t('回收站已清空'));
    } catch (caught) {
      showToast('error', t((caught as Error).message));
    } finally {
      setEmptyingTrash(false);
    }
  }

  function purgeLabel(asset: Asset) {
    if (!asset.purgeAfter) return t('等待永久删除');
    const when = new Date(asset.purgeAfter);
    const formatted = when.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
    return t('将于该时间永久删除') + ' ' + formatted;
  }

  async function beginShare(asset: Asset) {
    setError('');
    setSharingAsset(asset);
    setShareDraft(asset.sharedTeamIds ?? []);
    try {
      const result = await api<{ items: Array<{ teamId: string }> }>('/assets/' + asset.id + '/shares');
      setShareDraft(result.items.map((item) => item.teamId));
    } catch (caught) {
      setError(t((caught as Error).message));
      setSharingAsset(null);
    }
  }

  async function saveShares() {
    if (!sharingAsset) return;
    setShareBusy(true);
    setError('');
    try {
      const result = await api<{ items: Array<{ teamId: string }> }>('/assets/' + sharingAsset.id + '/shares', json('PUT', { teamIds: shareDraft }));
      const teamIds = result.items.map((item) => item.teamId);
      setMineAssets((current) => current.map((item) => item.id === sharingAsset.id ? { ...item, sharedTeamIds: teamIds } : item));
      setSharingAsset(null);
    } catch (caught) {
      setError(t((caught as Error).message));
    } finally {
      setShareBusy(false);
    }
  }

  async function unshare(asset: Asset) {
    if (!asset.team?.id) return;
    if (!confirm(t('取消分享后，团队成员将无法再看到这张图片。'))) return;
    setError('');
    try {
      await api('/assets/' + asset.id + '/shares/' + asset.team.id, json('DELETE'));
      setSharedAssets((current) => current.filter((item) => item.shareId !== asset.shareId));
      setSharedTotal((count) => Math.max(0, count - 1));
    } catch (caught) {
      setError(t((caught as Error).message));
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    const allSelected = items.length > 0 && items.every((asset) => selectedIds.has(asset.id));
    setSelectedIds(allSelected ? new Set() : new Set(items.map((asset) => asset.id)));
  }

  async function downloadSelected() {
    const selected = items.filter((asset) => selectedIds.has(asset.id));
    if (!selected.length) {
      showToast('error', t('请先选择要下载的图片'));
      return;
    }
    setDownloadBusy(true);
    setDownloadProgress(0);
    try {
      const result = await downloadFiles(selected.map((asset, index) => ({
        url: asset.contentUrl,
        name: 'asset-' + String(index + 1).padStart(4, '0') + extensionForMime(asset.mimeType),
      })), (completed) => setDownloadProgress(completed));
      if (result.failed.length) showToast('error', t('下载超时'));
      else showToast('success', t('下载成功'));
    } catch {
      showToast('error', t('下载超时'));
    } finally {
      setDownloadBusy(false);
    }
  }

  async function loadMore() {
    setSelectedIds(new Set());
    await loadPage(false);
  }

  const heading = tab === 'mine' ? t('资产库') : tab === 'shared' ? t('团队素材') : t('回收站');
  const description = tab === 'mine'
    ? t('集中查看和管理你的上传图片与生成结果。')
    : tab === 'shared'
      ? t('查看同团队成员分享的参考图。内容仍占用分享者的存储配额。')
      : t('已删除的资产会在这里保留一段时间，到期后永久移除。回收站内的文件仍占用存储配额。');
  const empty = filtering
    ? <div className="empty-state"><Icon className="empty-icon" name="image" /><h2>{t('没有符合条件的资产')}</h2><p className="muted">{t('试试调整类型、来源、模型、日期或关键词。')}</p><button className="button" type="button" onClick={clearFilters}>{t('清除筛选')}</button></div>
    : tab === 'mine'
      ? <div className="empty-state"><Icon className="empty-icon" name="image" /><h2>{t('资产库还是空的')}</h2><p className="muted">{t('上传图片或完成一次创作后，内容会显示在这里。')}</p><button className="button primary" onClick={onStartCreation}>{t('开始创作')}</button></div>
      : tab === 'trash'
        ? <div className="empty-state"><Icon className="empty-icon" name="delete" /><h2>{t('回收站是空的')}</h2><p className="muted">{t('删除的资产会先出现在这里，你可以随时恢复。')}</p></div>
      : isAdmin && !teamId
        ? <div className="empty-state"><Icon className="empty-icon" name="team" /><h2>{t('选择一个工作团队')}</h2><p className="muted">{t('管理员需要先选择工作团队，才能查看该团队已分享的素材。')}</p></div>
        : !teams.length
          ? <div className="empty-state"><Icon className="empty-icon" name="team" /><h2>{t('还没有工作团队')}</h2><p className="muted">{t('你还不在任何工作团队中，请联系管理员。')}</p></div>
          : <div className="empty-state"><Icon className="empty-icon" name="image" /><h2>{t('团队内还没有分享的图片')}</h2><p className="muted">{t('团队成员可以从自己的资产库把图片分享到工作团队。')}</p></div>;

  return <section className="asset-library">
    <Toast toast={toast} />
    <div className="section-heading">
      <div>
        <h1>{heading}</h1>
        <p className="muted">{description}</p>
      </div>
      <span className="asset-total">{total} {t('项资产')}</span>
    </div>
    <div className="asset-tabs" role="tablist" aria-label={t('资产库分类')}>
      <button className={tab === 'mine' ? 'active' : ''} type="button" role="tab" aria-selected={tab === 'mine'} onClick={() => { setTab('mine'); setFilterOpen(false); setError(''); }}>{t('我的资产')}</button>
      <button className={tab === 'shared' ? 'active' : ''} type="button" role="tab" aria-selected={tab === 'shared'} onClick={() => { setTab('shared'); setFilterOpen(false); setError(''); }}>{t('团队素材')}</button>
      <button className={tab === 'trash' ? 'active' : ''} type="button" role="tab" aria-selected={tab === 'trash'} onClick={() => { setTab('trash'); setFilterOpen(false); setError(''); }}>{t('回收站')}</button>
    </div>
    {tab === 'shared' && teams.length > 0 && <div className="asset-group-filters">
      {!isAdmin && <button className={!teamId ? 'active' : ''} type="button" onClick={() => setTeamId('')}>{t('全部团队')}</button>}
      {teams.map((team) => <button key={team.id} className={teamId === team.id ? 'active' : ''} type="button" onClick={() => setTeamId(team.id)}>{team.name}</button>)}
    </div>}
    <div className="asset-bulk-toolbar">
      <div className="asset-filter">
        {filterOpen && <div className="asset-filter-scrim" onPointerDown={() => setFilterOpen(false)} />}
        <button
          ref={filterTriggerRef}
          className={'asset-filter-trigger' + (filtering || filterOpen ? ' active' : '')}
          type="button"
          aria-expanded={filterOpen}
          aria-haspopup="true"
          aria-controls="asset-filter-menu"
          aria-label={t('筛选')}
          onClick={() => setFilterOpen((open) => !open)}
        >
          <Icon name="filter" />
          {t('筛选')}
          {filterCount > 0 && <span className="asset-filter-count">{filterCount}</span>}
        </button>
        {filterOpen && <section className="asset-filter-menu" id="asset-filter-menu" style={filterMenuStyle} role="dialog" aria-label={t('筛选')}>
          <div className="asset-filter-menu-head">
            <strong>{t('筛选')}</strong>
            <button className="button" type="button" disabled={!filtering} onClick={clearFilters}>{t('清除筛选')}</button>
          </div>
          <div className="asset-filter-grid">
            {tab === 'mine' && <label className="asset-filter-label asset-filter-span">{t('关键词')}
              <input className="field" type="search" value={qDraft} maxLength={100} placeholder={t('搜索备注或提示词')} onChange={(event) => setQDraft(event.target.value)} />
            </label>}
            <div className="asset-filter-group">
              <p>{t('素材类型')}</p>
              <div className="asset-filter-choices" role="group" aria-label={t('素材类型')}>
                <button className={filters.mediaKind === 'ALL' ? 'active' : ''} type="button" onClick={() => patchFilter('mediaKind', 'ALL')}>{t('全部')}</button>
                <button className={filters.mediaKind === 'IMAGE' ? 'active' : ''} type="button" onClick={() => patchFilter('mediaKind', 'IMAGE')}>{t('图片')}</button>
                <button className={filters.mediaKind === 'VIDEO' ? 'active' : ''} type="button" onClick={() => patchFilter('mediaKind', 'VIDEO')}>{t('视频')}</button>
              </div>
            </div>
            <div className="asset-filter-group">
              <p>{t('来源')}</p>
              <div className="asset-filter-choices" role="group" aria-label={t('来源')}>
                <button className={filters.role === 'ALL' ? 'active' : ''} type="button" onClick={() => patchFilter('role', 'ALL')}>{t('全部')}</button>
                <button className={filters.role === 'OUTPUT' ? 'active' : ''} type="button" onClick={() => patchFilter('role', 'OUTPUT')}>{t('生成')}</button>
                <button className={filters.role === 'UPLOAD' ? 'active' : ''} type="button" onClick={() => patchFilter('role', 'UPLOAD')}>{t('上传')}</button>
              </div>
            </div>
            <label className="asset-filter-label asset-filter-span">{t('模型')}
              <select className="field" value={filters.modelId} disabled={filters.role === 'UPLOAD'} onChange={(event) => patchFilter('modelId', event.target.value)}>
                <option value="">{t('全部模型')}</option>
                {modelOptions.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
              </select>
            </label>
            <label className="asset-filter-label">{t('起始日期')}
              <input className="field" type="date" value={filters.from ?? ''} onChange={(event) => patchFilter('from', event.target.value)} />
            </label>
            <label className="asset-filter-label">{t('结束日期')}
              <input className="field" type="date" value={filters.to ?? ''} onChange={(event) => patchFilter('to', event.target.value)} />
            </label>
          </div>
        </section>}
      </div>
      <button className="button" type="button" disabled={!items.length || downloadBusy} onClick={toggleAll}>{items.length > 0 && items.every((asset) => selectedIds.has(asset.id)) ? t('取消全选') : t('全选当前页')}</button>
      <span className="muted">{t('已选择')} {selectedIds.size}</span>
      <button className="button primary" type="button" disabled={!selectedIds.size || downloadBusy} onClick={() => void downloadSelected()}>{downloadBusy ? t('下载中…') + ' ' + downloadProgress + '/' + selectedIds.size : t('下载所选素材')}</button>
      {tab === 'trash' && <button className="button danger" type="button" disabled={!trashTotal || emptyingTrash} onClick={() => void emptyTrash()}>{emptyingTrash ? t('清空中…') : t('清空回收站')}</button>}
    </div>
    {error && <p className="error">{error}</p>}
    {loading && !items.length ? <p className="muted">{t('加载中…')}</p> : items.length === 0 ? empty : <div className="gallery">
      {items.map((asset) => <article className={'card image-card asset-card ' + (selectedIds.has(asset.id) ? 'asset-selected' : '')} key={asset.shareId ?? asset.id}>
        <label className="asset-select">
          <input type="checkbox" checked={selectedIds.has(asset.id)} onChange={() => toggleSelected(asset.id)} aria-label={t('选择图片下载')} />
        </label>
        {tab === 'mine' && Boolean(asset.sharedTeamIds?.length) && <span className="asset-share-badge">{t('已分享')}</span>}
        <button className="image-thumbnail" type="button" onClick={() => onOpenAsset(asset)} aria-label={asset.mediaKind === 'VIDEO' ? t('播放生成视频') : t('放大查看图片')}>
          {asset.thumbnailUrl
            ? <img src={asset.thumbnailUrl} width={asset.thumbnailWidth ?? undefined} height={asset.thumbnailHeight ?? undefined} loading="lazy" decoding="async" alt={asset.role === 'OUTPUT' ? t('生成资产') : t('上传资产')} />
            : <span className="image-preview-missing">{t('暂无预览')}</span>}
          {asset.mediaKind === 'VIDEO' && <Icon className="video-play-badge" name="play" />}
          <span className="image-expand" aria-hidden="true">{asset.mediaKind === 'VIDEO' ? t('播放') : t('放大')}</span>
        </button>
        <div className="asset-meta">
          <span className="asset-kind">{asset.role === 'OUTPUT' ? t('生成') : t('上传')}</span>
          <span className="muted">{asset.width} × {asset.height}</span>
        </div>
        {tab === 'shared' && <p className="asset-note-preview">{asset.sharedBy?.displayName} · {asset.team?.name}</p>}
        {tab === 'mine' && <p className={'asset-note-preview ' + (asset.note ? '' : 'empty')} title={asset.note ?? undefined}>{asset.note || '\u00a0'}</p>}
        {tab === 'trash' && <p className="asset-note-preview" title={purgeLabel(asset)}>{purgeLabel(asset)}</p>}
        <div className="asset-actions">
          {tab === 'shared' && asset.mediaKind !== 'VIDEO' && <button className="icon-action" type="button" onClick={() => onUseAsReference(asset)} aria-label={t('设为参考图')} title={t('设为参考图')}><Icon name="reference" /></button>}
          {tab === 'mine' && <button className={'icon-action ' + (asset.sharedTeamIds?.length ? 'has-value' : '')} type="button" disabled={!canShare} onClick={() => void beginShare(asset)} aria-label={t('分享到工作团队')} title={canShare ? t('分享到工作团队') : t('你还不在任何工作团队中，请联系管理员。')}><Icon name="share" /></button>}
          {tab === 'mine' && <button className={'icon-action ' + (asset.note ? 'has-value' : '')} type="button" onClick={() => beginNote(asset)} aria-label={asset.note ? t('编辑备注') : t('添加备注')} title={asset.note ? t('编辑备注') : t('添加备注')}><Icon name="note" /></button>}
          {tab === 'mine' && <button className="icon-action danger-action" type="button" onClick={() => void deleteAsset(asset)} aria-label={t('删除资产')} title={t('删除')}><Icon name="delete" /></button>}
          {tab === 'trash' && <button className="icon-action" type="button" onClick={() => void restoreAsset(asset)} aria-label={t('恢复资产')} title={t('恢复')}><Icon name="restore" /></button>}
          {tab === 'trash' && <button className="icon-action danger-action" type="button" onClick={() => void purgeAsset(asset)} aria-label={t('永久删除')} title={t('永久删除')}><Icon name="delete" /></button>}
          {tab === 'shared' && asset.canUnshare && <button className="icon-action danger-action" type="button" onClick={() => void unshare(asset)} aria-label={t('取消分享')} title={t('取消分享')}><Icon name="unshare" /></button>}
        </div>
      </article>)}
    </div>}
    {hasMore && <button className="button" type="button" onClick={() => void loadMore()}>{t('加载更多资产')}</button>}
    {noteAsset && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeNote(); }}>
      <section className="confirm-dialog note-dialog" role="dialog" aria-modal="true" aria-labelledby="note-title">
        <h2 id="note-title">{noteAsset.note ? t('编辑备注') : t('添加备注')}</h2>
        {noteError && <p className="error">{noteError}</p>}
        <textarea className="field" value={noteDraft} maxLength={1000} autoFocus placeholder={t('输入资产备注')} onChange={(event) => setNoteDraft(event.target.value)} />
        <div className="asset-note-editor-actions">
          <span className="muted note-count">{noteDraft.length}/1000</span>
          <button className="button" type="button" onClick={() => setNoteDraft('')} disabled={!noteDraft || noteBusy}>{t('清空')}</button>
          <button className="button" type="button" onClick={closeNote} disabled={noteBusy}>{t('取消')}</button>
          <button className="button primary" type="button" onClick={() => void saveNote()} disabled={noteBusy}>{noteBusy ? t('保存中…') : t('保存')}</button>
        </div>
      </section>
    </div>}
    {sharingAsset && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !shareBusy) setSharingAsset(null); }}>
      <section className="confirm-dialog share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <h2 id="share-title">{t('分享到工作团队')}</h2>
        <p>{t('团队成员可以查看、下载，并在整图编辑或局部重绘中作为参考图。不会复制文件，也不占用对方的存储配额。')}</p>
        <div className="permission-options share-group-options">
          {teams.map((team) => <label key={team.id}><input type="checkbox" checked={shareDraft.includes(team.id)} onChange={(event) => setShareDraft((current) => event.target.checked ? [...current, team.id] : current.filter((id) => id !== team.id))} /> {team.name}</label>)}
        </div>
        <div className="dialog-actions">
          <button className="button" type="button" onClick={() => setSharingAsset(null)} disabled={shareBusy}>{t('取消')}</button>
          <button className="button primary" type="button" onClick={() => void saveShares()} disabled={shareBusy}>{shareBusy ? t('保存中…') : t('保存')}</button>
        </div>
      </section>
    </div>}
  </section>;
}
