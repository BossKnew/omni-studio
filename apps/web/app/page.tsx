import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@/lib/router';
import { api, json } from '@/lib/api';
import { downloadFiles, type DownloadResult } from '@/lib/download';
import { isTerminalGenerationStatus, parseGenerationEvent } from '@/lib/generation-events';
import { getActiveGenerationJobs, type Asset, type ConversationDetail, type ConversationSummary, type CursorPage, type DownloadAsset, type GenerationCreated, type GenerationJob, type GenerationReuse, type ReferenceSelection, type StudioModel, type StudioUser, type UsageSnapshot } from '@/lib/studio-types';
import type { OptionLabelMap } from '@/lib/option-labels';
import AssetLibrary from '@/components/AssetLibrary';
import ImageLightbox, { type LightboxImage } from '@/components/ImageLightbox';
import JobHistory from '@/components/JobHistory';
import PasswordChange from '@/components/PasswordChange';
import ProfileDialog from '@/components/ProfileDialog';
import StudioComposer from '@/components/StudioComposer';
import StudioSidebar from '@/components/StudioSidebar';
import { LanguageSwitcher, useI18n } from '@/lib/i18n';

type StudioView = 'studio' | 'assets';
type ViewerState = { image: LightboxImage; reference?: Asset };
type ConversationDeletion = { ok: true; deletedAssetIds: string[] };
const HEALTHY_RECONCILE_MS = 30 * 1000;
const FALLBACK_POLL_MS = 10 * 1000;

export default function StudioPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [user, setUser] = useState<StudioUser | null>(null);
  const [models, setModels] = useState<StudioModel[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationCursor, setConversationCursor] = useState<string | null>(null);
  const [assetTotal, setAssetTotal] = useState(0);
  const [libraryEpoch, setLibraryEpoch] = useState(0);
  const [view, setView] = useState<StudioView>('studio');
  const [libraryMounted, setLibraryMounted] = useState(false);
  if (view === 'assets' && !libraryMounted) setLibraryMounted(true);
  const [conversationId, setConversationId] = useState('');
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [references, setReferences] = useState<ReferenceSelection[]>([]);
  const [reusePreset, setReusePreset] = useState<GenerationReuse | null>(null);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [streamConnected, setStreamConnected] = useState(false);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [optionLabels, setOptionLabels] = useState<OptionLabelMap>({});
  const selectedConversationRef = useRef('');
  const handledTerminalJobs = useRef(new Set<string>());
  const collectionRefreshRef = useRef<Promise<void> | null>(null);
  const collectionRevisionRef = useRef(0);

  const applyUsage = useCallback((snapshot: UsageSnapshot) => {
    setUsage(snapshot);
    if (typeof snapshot.libraryAssetCount === 'number') setAssetTotal(snapshot.libraryAssetCount);
  }, []);

  const refreshCollections = useCallback(() => {
    if (collectionRefreshRef.current) return collectionRefreshRef.current;
    const revision = collectionRevisionRef.current;
    let refresh!: Promise<void>;
    refresh = (async () => {
      const conversationPage = await api<CursorPage<ConversationSummary>>('/conversations');
      if (collectionRevisionRef.current !== revision) return;
      setConversations(conversationPage.items);
      setConversationCursor(conversationPage.nextCursor);
    })().finally(() => { if (collectionRefreshRef.current === refresh) collectionRefreshRef.current = null; });
    collectionRefreshRef.current = refresh;
    return refresh;
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    setView('studio');
    selectedConversationRef.current = id;
    setConversationId(id);
    const detail = await api<ConversationDetail>(`/conversations/${id}`);
    if (selectedConversationRef.current === id) setConversation(detail);
  }, []);

  const applyJobUpdate = useCallback((updatedJob: GenerationJob) => {
    const targetConversationId = updatedJob.conversationId;
    startTransition(() => {
      setConversation((current) => {
        if (!current || targetConversationId && current.id !== targetConversationId) return current;
        const hasJob = current.jobs.some((job) => job.id === updatedJob.id);
        return { ...current, jobs: hasJob ? current.jobs.map((job) => job.id === updatedJob.id ? updatedJob : job) : [...current.jobs, updatedJob] };
      });
    });
  }, []);

  const handleGenerationUpdate = useCallback(async (job: GenerationJob) => {
    applyJobUpdate(job);
    if (!isTerminalGenerationStatus(job.status)) {
      handledTerminalJobs.current.delete(job.id);
      return;
    }
    if (handledTerminalJobs.current.has(job.id)) return;
    handledTerminalJobs.current.add(job.id);
    try {
      const [usageSnapshot] = await Promise.all([api<UsageSnapshot>('/usage'), refreshCollections()]);
      applyUsage(usageSnapshot);
      if (job.status === 'SUCCEEDED') setLibraryEpoch((epoch) => epoch + 1);
      setSyncError('');
    } catch {
      setSyncError(t('任务状态已更新，但摘要同步失败。请刷新页面。'));
    }
  }, [applyJobUpdate, applyUsage, refreshCollections]);

  useEffect(() => {
    async function loadWorkspace() {
      try {
        const me = await api<{ user: StudioUser }>('/auth/me');
        setUser(me.user);
        if (me.user.mustChangePwd) return;
        const [modelRows, usageSnapshot, labels] = await Promise.all([
          api<StudioModel[]>('/models'),
          api<UsageSnapshot>('/usage'),
          api<OptionLabelMap>('/option-labels'),
          refreshCollections(),
        ]);
        setModels(modelRows);
        applyUsage(usageSnapshot);
        setOptionLabels(labels);
      } catch {
        router.replace('/login');
      }
    }
    void loadWorkspace();
  }, [applyUsage, refreshCollections, router]);

  useEffect(() => {
    if (!user || user.mustChangePwd) return;
    const source = new EventSource('/api/v1/generations/events');
    source.onopen = () => setStreamConnected(true);
    source.onerror = () => setStreamConnected(false);
    source.onmessage = (event) => {
      const job = parseGenerationEvent(event.data);
      if (job) void handleGenerationUpdate(job);
    };
    return () => { source.close(); setStreamConnected(false); };
  }, [handleGenerationUpdate, user]);

  useEffect(() => {
    const active = conversation ? getActiveGenerationJobs(conversation) : [];
    if (!active.length) return;
    const reconcile = async () => {
      try {
        const batches = Array.from({ length: Math.ceil(active.length / 3) }, (_, index) => active.slice(index * 3, index * 3 + 3));
        const pages = await Promise.all(batches.map((batch) => api<GenerationJob[]>(`/generations/status?ids=${encodeURIComponent(batch.map(({ id }) => id).join(','))}`)));
        for (const job of pages.flat()) await handleGenerationUpdate(job);
      } catch { /* The event stream or next reconciliation can recover. */ }
    };
    if (!streamConnected) void reconcile();
    const timer = window.setInterval(() => void reconcile(), streamConnected ? HEALTHY_RECONCILE_MS : FALLBACK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [conversation, handleGenerationUpdate, streamConnected]);

  function startNewCreation() {
    setView('studio');
    selectedConversationRef.current = '';
    setConversationId('');
    setConversation(null);
    setReferences([]);
    setReusePreset(null);
  }

  async function renameConversation(id: string, title: string) {
    await api(`/conversations/${id}`, json('PATCH', { title }));
    setConversations((items) => items.map((item) => item.id === id ? { ...item, title } : item));
    setConversation((current) => current?.id === id ? { ...current, title } : current);
  }

  async function deleteConversation() {
    if (!deleteTarget) return;
    setActionBusy(true);
    setActionError('');
    try {
      const result = await api<ConversationDeletion>(`/conversations/${deleteTarget.id}`, json('DELETE'));
      const deletedAssetIds = new Set(result.deletedAssetIds);
      const revision = ++collectionRevisionRef.current;
      setConversations((items) => items.filter((item) => item.id !== deleteTarget.id));
      setAssetTotal((total) => Math.max(0, total - deletedAssetIds.size));
      setReferences((current) => current.filter((reference) => reference.kind !== 'asset' || !deletedAssetIds.has(reference.asset.id)));
      if (viewer && deletedAssetIds.has(viewer.image.id)) setViewer(null);
      if (selectedConversationRef.current === deleteTarget.id) startNewCreation();
      setDeleteTarget(null);
      setLibraryEpoch((epoch) => epoch + 1);
      try {
        const usageSnapshot = await api<UsageSnapshot>('/usage');
        if (collectionRevisionRef.current === revision) applyUsage(usageSnapshot);
        setSyncError('');
      } catch {
        setSyncError(t('会话已删除，但资产列表同步失败。请刷新页面。'));
      }
    } catch (caught) {
      setActionError((caught as Error).message);
    } finally {
      setActionBusy(false);
    }
  }

  const handleCreated = useCallback(async (result: GenerationCreated) => {
    await loadConversation(result.conversationId);
    try { applyUsage(await api<UsageSnapshot>('/usage')); } catch { /* The next completed job can refresh usage. */ }
  }, [applyUsage, loadConversation]);

  const clearReusePreset = useCallback(() => setReusePreset(null), []);

  const retryGeneration = useCallback(async (jobId: string) => {
    const result = await api<GenerationCreated>(`/generations/${jobId}/retry`, json('POST'));
    await loadConversation(result.conversationId);
  }, [loadConversation]);

  const reuseGeneration = useCallback(async (jobId: string) => {
    const preset = await api<GenerationReuse>(`/generations/${jobId}/reuse`);
    setView('studio');
    setReusePreset(preset);
  }, []);

  const downloadConversation = useCallback(async (id: string): Promise<DownloadResult> => {
    const result = await api<{ items: DownloadAsset[]; total: number }>(`/conversations/${id}/output-assets`);
    if (!result.items.length) throw new Error(t('当前会话没有可下载的生成素材'));
    return downloadFiles(result.items.map((item) => ({ url: item.contentUrl, name: item.downloadName })));
  }, [t]);

  async function loadMoreConversations() {
    if (!conversationCursor) return;
    const page = await api<CursorPage<ConversationSummary>>(`/conversations?cursor=${encodeURIComponent(conversationCursor)}`);
    setConversations((current) => [...current, ...page.items]);
    setConversationCursor(page.nextCursor);
  }

  const loadOlderJobs = useCallback(async () => {
    if (!conversation?.nextJobCursor) return;
    const older = await api<ConversationDetail>(`/conversations/${conversation.id}?jobCursor=${encodeURIComponent(conversation.nextJobCursor)}`);
    setConversation((current) => current?.id === older.id ? { ...current, jobs: [...older.jobs, ...current.jobs], nextJobCursor: older.nextJobCursor } : current);
  }, [conversation]);

  function updateAssetNote(id: string, note: string | null) {
    setConversation((current) => current ? {
      ...current,
      jobs: current.jobs.map((job) => ({ ...job, assets: job.assets.map((asset) => asset.id === id ? { ...asset, note } : asset) })),
    } : current);
  }

  function removeAsset(asset: Asset) {
    setAssetTotal((total) => Math.max(0, total - 1));
    setReferences((current) => current.filter((reference) => reference.kind !== 'asset' || reference.asset.id !== asset.id));
    if (viewer?.image.id === asset.id) setViewer(null);
  }

  const selectReference = useCallback((asset: Asset, generationPrompt?: string) => {
    if (asset.mediaKind === 'VIDEO') {
      setSyncError(t('视频不能作为参考图'));
      return;
    }
    setReferences((current) => {
      if (current.some((reference) => reference.kind === 'asset' && reference.asset.id === asset.id)) return current;
      if (current.length >= 8) {
        setSyncError(t('参考图最多支持 8 张'));
        return current;
      }
      const selected = generationPrompt === undefined ? asset : { ...asset, generationPrompt };
      return [...current, { key: 'asset-' + asset.id, kind: 'asset', asset: selected }];
    });
    setViewer(null);
  }, [t]);

  const openJobImage = useCallback((asset: Asset) => {
    setViewer({ image: toLightboxImage(asset, t), reference: asset });
  }, [t]);

  const requestDeleteConversation = useCallback(() => {
    if (!conversation) return;
    setDeleteTarget(conversations.find((item) => item.id === conversation.id) ?? { id: conversation.id, title: conversation.title });
  }, [conversation, conversations]);

  const referenceIds = useMemo(
    () => references.filter((reference) => reference.kind === 'asset').map((reference) => reference.asset.id),
    [references],
  );

  async function logout() {
    await api('/auth/logout', json('POST'));
    router.replace('/login');
  }

  if (!user) return <main className="auth-page">{t('加载中…')}</main>;
  if (user.mustChangePwd) return <PasswordChange role={user.role} />;

  return <div className="shell">
    <StudioSidebar
      user={user}
      assetCount={assetTotal}
      conversations={conversations}
      activeConversationId={conversationId}
      activeView={view}
      onNewCreation={startNewCreation}
      onShowAssets={() => setView('assets')}
      onLoadConversation={loadConversation}
      hasMoreConversations={Boolean(conversationCursor)}
      onLoadMoreConversations={loadMoreConversations}
      onRenameConversation={renameConversation}
      onDeleteConversation={(item) => { setDeleteTarget(item); setActionError(''); }}
      onShowProfile={() => setProfileOpen(true)}
      onNavigateToAccount={() => router.push(user.role === 'ADMIN' ? '/admin' : '/settings')}
      onLogout={logout}
      usage={usage}
    />
    <main className="main">
      <div className="workspace-topbar"><LanguageSwitcher /></div>
      {syncError && <p className="error" role="alert">{syncError}</p>}
      {libraryMounted && <div style={{ display: view === 'assets' ? undefined : 'none', minHeight: 0, flex: 1, overflow: 'auto' }}><AssetLibrary models={models} libraryEpoch={libraryEpoch} onStartCreation={startNewCreation} onOpenAsset={(asset) => setViewer({ image: toLightboxImage(asset, t), reference: asset.deletedAt ? undefined : asset })} onUseAsReference={(asset) => selectReference(asset)} onAssetNoteSaved={updateAssetNote} onAssetDeleted={removeAsset} onAssetRestored={() => setAssetTotal((total) => total + 1)} isAdmin={user.role === 'ADMIN'} /></div>}
      <div className={`studio-workspace ${conversationId ? 'has-conversation' : ''}`} style={{ display: view === 'assets' ? 'none' : undefined }}>
        <StudioComposer models={models} optionLabels={optionLabels} conversationId={conversationId} references={references} onReferencesChange={setReferences} reusePreset={reusePreset} onReuseConsumed={clearReusePreset} onCreated={handleCreated} />
        {conversation && <JobHistory conversation={conversation} onLoadOlder={loadOlderJobs} referenceIds={referenceIds} onDeleteConversation={requestDeleteConversation} onUseAsReference={selectReference} onOpenImage={openJobImage} onRetry={retryGeneration} onReuse={reuseGeneration} onDownloadConversation={downloadConversation} />}
      </div>
    </main>

    {viewer && <ImageLightbox image={viewer.image} onClose={() => setViewer(null)} onUseAsReference={viewer.reference ? () => selectReference(viewer.reference!, viewer.image.prompt ?? undefined) : undefined} />}
    {profileOpen && <ProfileDialog user={user} onClose={() => setProfileOpen(false)} onSaved={(displayName) => setUser((current) => current ? { ...current, displayName } : current)} />}
    {deleteTarget && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !actionBusy) setDeleteTarget(null); }}>
      <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-description">
        <div className="warning-icon" aria-hidden="true">!</div><h2 id="delete-title">{t('删除会话')}“{deleteTarget.title}”？</h2>
        <p id="delete-description">{t('该会话、其中生成的图片、本会话独占的上传原图以及失败任务保留的遮罩都会被永久删除，此操作无法撤销。仍被其他会话使用的上传原图会保留。')}</p>
        {actionError && <p className="error">{actionError}</p>}
        <div className="dialog-actions"><button className="button" onClick={() => setDeleteTarget(null)} disabled={actionBusy}>{t('取消')}</button><button className="button danger" onClick={() => void deleteConversation()} disabled={actionBusy}>{actionBusy ? t('正在删除…') : t('确认删除')}</button></div>
      </section>
    </div>}
  </div>;
}

function toLightboxImage(asset: Asset, t: (key: string) => string): LightboxImage {
  const shared = asset.visibility === 'shared';
  return {
    id: asset.id,
    src: asset.contentUrl,
    poster: asset.thumbnailUrl,
    alt: asset.role === 'OUTPUT' ? t('生成资产') : t('上传资产'),
    kind: asset.mediaKind === 'VIDEO' ? (asset.role === 'OUTPUT' ? t('生成视频') : t('上传视频')) : (asset.role === 'OUTPUT' ? t('生成图片') : t('上传图片')),
    mediaKind: asset.mediaKind,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    durationMs: asset.durationMs,
    prompt: shared ? null : asset.generationPrompt,
    note: shared ? null : asset.note,
    sharedBy: asset.sharedBy?.displayName ?? null,
    sharedTeamName: asset.team?.name ?? null,
  };
}
