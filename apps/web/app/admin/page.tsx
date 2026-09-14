import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from '@/lib/router';
import { api, json } from '@/lib/api';
import { formatStorageBytes } from '@/lib/format-bytes';
import SecuritySettings from '@/components/SecuritySettings';
import PromptPolishSettings from '@/components/PromptPolishSettings';
import OptionLabelsSettings from '@/components/OptionLabelsSettings';
import StylePresetsSettings from '@/components/StylePresetsSettings';
import { passwordRequirement } from '@/lib/password-policy';
import type { CursorPage, SecurityUser } from '@/lib/studio-types';
import { LanguageSwitcher, useI18n } from '@/lib/i18n';
import Icon, { type IconName } from '@/components/Icon';

type AdminView = 'users' | 'groups' | 'teams' | 'usage' | 'providers' | 'models' | 'labels' | 'style-presets' | 'prompt-polish' | 'security';
type AdapterKind = 'openai-images' | 'qwen-image' | 'nano-banana' | 'seedream' | 'midjourney' | 'flux' | 'runway-images' | 'openai-videos' | 'seedance' | 'wan' | 'veo' | 'minimax' | 'runway' | 'flux-video';
type MediaKind = 'IMAGE' | 'VIDEO';
type Provider = { id: string; name: string; baseUrl: string; timeoutSeconds: number; pollTimeoutSeconds?: number; enabled: boolean; testCooldownUntil: string | null; lastTestOk: boolean | null; _count?: { models: number } };
type UserGroup = { id: string; name: string; description: string | null; quotaWindow: string | null; quotaPoints?: number | null; _count: { users: number; models: number } };
type WorkTeam = { id: string; name: string; description: string | null; _count: { users: number; assetShares?: number } };
type AdminModel = { id: string; providerId: string; displayName: string; upstreamModelId: string; adapterKind: AdapterKind; mediaKind: MediaKind; allowedSizes: string[]; resolutionTiers: Array<{ label: string; shortEdge: number }>; allowedRatios: string[]; allowedQualities: string[]; allowedDurations: number[]; supportsEdit: boolean; supportsInpaint: boolean; supportsFirstLastFrame: boolean; maxImages: number; maxInputImages: number; costPerUnit: number; pointMultipliers?: Record<string, number> | null; enabled: boolean; provider: { id: string; name: string }; allowedGroups: Array<{ groupId: string; group: { id: string; name: string } }> };
type ProviderForm = { name: string; baseUrl: string; apiKey: string; timeoutSeconds: number; pollTimeoutSeconds: number };
type ModelForm = { providerId: string; mediaKind: MediaKind; adapterKind: AdapterKind; displayName: string; upstreamModelId: string; allowedSizes: string; tierRows: TierRowInput[]; allowedRatios: string; allowedQualities: string; allowedDurations: string; supportsEdit: boolean; supportsInpaint: boolean; supportsFirstLastFrame: boolean; maxImages: number; maxInputImages: number; costPerUnit: string;  allowedGroupIds: string[] };
type ResolutionTierInput = { label: string; shortEdge: number };

type TierRowInput = { label: string; shortEdge: string; multiplier: string };

function zipTierRows(rows: TierRowInput[]): Array<ResolutionTierInput & { multiplier: string }> {
  const result: Array<ResolutionTierInput & { multiplier: string }> = [];
  const seen = new Set<number>();
  rows.forEach((row) => {
    const label = row.label.trim();
    const shortEdge = Number(row.shortEdge.trim());
    if (!label || !Number.isInteger(shortEdge) || shortEdge < 64 || shortEdge > 8192 || seen.has(shortEdge)) return;
    seen.add(shortEdge);
    result.push({ label, shortEdge, multiplier: row.multiplier.trim() });
  });
  return result;
}
type GroupForm = { name: string; description: string; quotaWindow: string; quotaPoints: string };
type TeamForm = { name: string; description: string };
type UsageRow = { userId: string; username: string; displayName: string; imageCount: number; videoSeconds?: number; points: number; events: number };
type Notice = { kind: 'success' | 'error'; message: string };
type AdminUser = { id: string; username: string; displayName: string; role: 'USER' | 'ADMIN'; status: string; groups: Array<{ id: string; name: string }>; teams: Array<{ id: string; name: string }>; mfaEnabled: boolean; mfaRequired: boolean; storageBytes: string };
type AdminSettings = { registrationEnabled: boolean; userSessionDuration?: string; trashRetention?: string; uploadMaxLongEdge?: number };
const UPLOAD_MAX_LONG_EDGE_OPTIONS = [2048, 4096, 6144, 8192];

const emptyProviderForm = (): ProviderForm => ({ name: '', baseUrl: '', apiKey: '', timeoutSeconds: 180, pollTimeoutSeconds: 900 });
const emptyModelForm = (): ModelForm => ({ providerId: '', mediaKind: 'IMAGE', adapterKind: 'openai-images', displayName: '', upstreamModelId: '', allowedSizes: '', tierRows: DEFAULT_TIER_ROWS.map((row) => ({ ...row })), allowedRatios: DEFAULT_RATIOS_TEXT, allowedQualities: 'auto,low,medium,high', allowedDurations: '5,10', supportsEdit: false, supportsInpaint: false, supportsFirstLastFrame: false, maxImages: 1, maxInputImages: 1, costPerUnit: '1', allowedGroupIds: [] });

const DEFAULT_TIER_ROWS: TierRowInput[] = [{ label: '1K', shortEdge: '1024', multiplier: '1' }];
const DEFAULT_VIDEO_TIER_ROWS: TierRowInput[] = [{ label: '720P', shortEdge: '720', multiplier: '1' }];
const FULL_DEFAULT_TIER_ROWS: TierRowInput[] = [
  { label: '1K', shortEdge: '1024', multiplier: '1' },
  { label: '2K', shortEdge: '1440', multiplier: '1' },
  { label: '4K', shortEdge: '2160', multiplier: '1' },
];
const DEFAULT_RATIOS_TEXT = '1:1,3:2,2:3,16:9';
const emptyGroupForm = (): GroupForm => ({ name: '', description: '', quotaWindow: '', quotaPoints: '' });
const emptyTeamForm = (): TeamForm => ({ name: '', description: '' });
const IMAGE_ADAPTERS: AdapterKind[] = ['openai-images', 'qwen-image', 'nano-banana', 'seedream', 'midjourney', 'flux', 'runway-images'];
const VIDEO_ADAPTERS: AdapterKind[] = ['openai-videos', 'seedance', 'wan', 'veo', 'minimax', 'runway', 'flux-video'];
function isVideoAdapter(kind?: string) { return VIDEO_ADAPTERS.includes(kind as AdapterKind); }
function adaptersForMedia(media: MediaKind): AdapterKind[] {
  return media === 'VIDEO' ? VIDEO_ADAPTERS : IMAGE_ADAPTERS;
}
function defaultAdapterForMedia(media: MediaKind): AdapterKind {
  return media === 'VIDEO' ? 'openai-videos' : 'openai-images';
}
function adapterLabel(kind: string | undefined, t: (key: string) => string) {
  if (kind === 'openai-videos') return t('Sora');
  if (kind === 'seedance') return t('Seedance');
  if (kind === 'wan') return t('Wan/HappyHorse');
  if (kind === 'veo') return t('Veo');
  if (kind === 'minimax') return t('MiniMax');
  if (kind === 'qwen-image') return t('Qwen/Wan');
  if (kind === 'nano-banana') return t('Nano Banana');
  if (kind === 'seedream') return t('Seedream');
  if (kind === 'midjourney') return t('Midjourney');
  if (kind === 'flux' || kind === 'flux-video') return t('Flux');
  if (kind === 'runway' || kind === 'runway-images') return t('Runway');
  return t('OpenAI Images');
}
function mediaFields(video: boolean): Pick<ModelForm, 'allowedSizes' | 'tierRows' | 'allowedRatios' | 'allowedQualities' | 'allowedDurations' | 'supportsInpaint' | 'supportsFirstLastFrame' | 'maxImages'> {
  return {
    allowedSizes: video ? '16:9,9:16,1:1' : '',
    tierRows: (video ? DEFAULT_VIDEO_TIER_ROWS : DEFAULT_TIER_ROWS).map((row) => ({ ...row })),
    allowedRatios: video ? '' : DEFAULT_RATIOS_TEXT,
    allowedQualities: video ? '720P,1080P' : 'auto,low,medium,high',
    allowedDurations: '5,10',
    supportsInpaint: false,
    supportsFirstLastFrame: false,
    maxImages: 1,
  };
}

function utcDay(offset = 0) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset)).toISOString().slice(0, 10);
}

export default function AdminPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [view, setView] = useState<AdminView>('users');
  const [currentUser, setCurrentUser] = useState<SecurityUser | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [userCursor, setUserCursor] = useState<string | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<AdminModel[]>([]);
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [teams, setTeams] = useState<WorkTeam[]>([]);
  const [registration, setRegistration] = useState(false);
  const [sessionDuration, setSessionDuration] = useState('7d');
  const [savingSessionDuration, setSavingSessionDuration] = useState(false);
  const [trashRetention, setTrashRetention] = useState('30d');
  const [savingTrashRetention, setSavingTrashRetention] = useState(false);
  const [uploadMaxLongEdge, setUploadMaxLongEdge] = useState(4096);
  const [savingUploadImage, setSavingUploadImage] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [providerForm, setProviderForm] = useState<ProviderForm>(emptyProviderForm);
  const [editingProviderId, setEditingProviderId] = useState('');
  const [modelForm, setModelForm] = useState<ModelForm>(emptyModelForm);
  const [editingModelId, setEditingModelId] = useState('');
  const [groupForm, setGroupForm] = useState<GroupForm>(emptyGroupForm);
  const [editingGroupId, setEditingGroupId] = useState('');
  const [teamForm, setTeamForm] = useState<TeamForm>(emptyTeamForm);
  const [editingTeamId, setEditingTeamId] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [clockNow, setClockNow] = useState(Date.now());
  const [usageFrom, setUsageFrom] = useState(() => utcDay(-6));
  const [usageTo, setUsageTo] = useState(() => utcDay(0));
  const [usageRows, setUsageRows] = useState<UsageRow[]>([]);
  const [usageBusy, setUsageBusy] = useState(false);

  const refreshUsers = useCallback(async () => {
    try {
      const [userRows, settings] = await Promise.all([
        api<CursorPage<AdminUser>>('/admin/users'), api<AdminSettings>('/admin/settings'),
      ]);
      setUsers(userRows.items);
      setUserCursor(userRows.nextCursor);
      setRegistration(settings.registrationEnabled);
      setSessionDuration(settings.userSessionDuration ?? '7d');
      setTrashRetention(settings.trashRetention ?? '30d');
      setUploadMaxLongEdge(settings.uploadMaxLongEdge ?? 4096);
      setError('');
    } catch (caught) { setError((caught as Error).message); }
  }, []);

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await api<Provider[]>('/admin/providers'));
      setError('');
    } catch (caught) { setError((caught as Error).message); }
  }, []);

  const refreshModels = useCallback(async () => {
    try {
      const [providerRows, modelRows, groupRows] = await Promise.all([api<Provider[]>('/admin/providers'), api<AdminModel[]>('/admin/models'), api<UserGroup[]>('/admin/user-groups')]);
      setProviders(providerRows);
      setModels(modelRows);
      setGroups(groupRows);
      setError('');
    } catch (caught) { setError((caught as Error).message); }
  }, []);

  const refreshGroups = useCallback(async () => {
    try {
      const [groupRows, userRows] = await Promise.all([api<UserGroup[]>('/admin/user-groups'), api<CursorPage<AdminUser>>('/admin/users')]);
      setGroups(groupRows); setUsers(userRows.items); setUserCursor(userRows.nextCursor); setError('');
    } catch (caught) { setError((caught as Error).message); }
  }, []);

  const refreshTeams = useCallback(async () => {
    try {
      const [teamRows, userRows] = await Promise.all([api<WorkTeam[]>('/admin/work-teams'), api<CursorPage<AdminUser>>('/admin/users')]);
      setTeams(teamRows); setUsers(userRows.items); setUserCursor(userRows.nextCursor); setError('');
    } catch (caught) { setError((caught as Error).message); }
  }, []);

  const refreshUsage = useCallback(async () => {
    setUsageBusy(true);
    try {
      const result = await api<{ items: UsageRow[] }>(`/admin/usage?from=${encodeURIComponent(usageFrom)}&to=${encodeURIComponent(usageTo)}`);
      setUsageRows(result.items);
      setError('');
    } catch (caught) { setError((caught as Error).message); }
    finally { setUsageBusy(false); }
  }, [usageFrom, usageTo]);

  useEffect(() => {
    api<{ user: SecurityUser }>('/auth/me').then((result) => {
      if (result.user.role !== 'ADMIN') { router.replace('/'); return; }
      setCurrentUser(result.user);
      setAuthorized(true);
    }).catch(() => router.replace('/login'));
  }, [router]);
  useEffect(() => {
    if (!authorized) return;
    if (view === 'users') void refreshUsers();
    if (view === 'groups') void refreshGroups();
    if (view === 'teams') void refreshTeams();
    if (view === 'usage') void refreshUsage();
    if (view === 'providers') void refreshProviders();
    if (view === 'models') void refreshModels();
  }, [authorized, refreshGroups, refreshModels, refreshProviders, refreshTeams, refreshUsage, refreshUsers, view]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!providers.some((provider) => provider.testCooldownUntil && new Date(provider.testCooldownUntil).getTime() > Date.now())) return;
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [providers]);

  function notify(kind: Notice['kind'], message: string) {
    setNotice({ kind, message });
  }

  function cancelProviderEdit() {
    setEditingProviderId('');
    setProviderForm(emptyProviderForm());
  }

  function beginProviderEdit(provider: Provider) {
    setEditingProviderId(provider.id);
    setProviderForm({ name: provider.name, baseUrl: provider.baseUrl, apiKey: '', timeoutSeconds: provider.timeoutSeconds, pollTimeoutSeconds: provider.pollTimeoutSeconds ?? 900 });
    setError('');
  }

  async function saveProvider(event: FormEvent) {
    event.preventDefault();
    const updating = Boolean(editingProviderId);
    setError('');
    try {
      if (editingProviderId) {
        const update = providerForm.apiKey ? providerForm : { name: providerForm.name, baseUrl: providerForm.baseUrl, timeoutSeconds: providerForm.timeoutSeconds, pollTimeoutSeconds: providerForm.pollTimeoutSeconds };
        await api(`/admin/providers/${editingProviderId}`, json('PATCH', update));
      }
      else await api('/admin/providers', json('POST', providerForm));
      cancelProviderEdit();
      await refreshProviders();
      notify('success', updating ? t('供应商修改已保存') : t('供应商保存成功'));
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message); notify('error', `${t('保存失败：')}${message}`);
    }
  }

  async function deleteProvider(provider: Provider) {
    if (!confirm(`${t('永久删除供应商')}“${provider.name}”${t('及其全部模型？历史生成记录会保留。')}`)) return;
    try {
      await api(`/admin/providers/${provider.id}`, json('DELETE'));
      if (editingProviderId === provider.id) cancelProviderEdit();
      await refreshProviders();
    } catch (caught) { setError((caught as Error).message); }
  }

  async function testProvider(provider: Provider) {
    setError('');
    try {
      const result = await api<{ ok: boolean; status?: number; error?: string; cooldownUntil: string }>(`/admin/providers/${provider.id}/test`, json('POST'));
      setProviders((items) => items.map((item) => item.id === provider.id ? { ...item, testCooldownUntil: result.cooldownUntil, lastTestOk: result.ok } : item));
      if (!result.ok) {
        const message = `${result.error ?? t('供应商测试失败')}${result.status ? ` (HTTP ${result.status})` : ''}`;
        setError(message); notify('error', message);
      } else notify('success', t('供应商连接测试成功'));
    } catch (caught) { const message = (caught as Error).message; setError(message); notify('error', message); }
  }

  function cancelModelEdit() {
    setEditingModelId('');
    setModelForm(emptyModelForm());
  }

  function openProviderModels(provider: Provider) {
    setEditingModelId('');
    setModelForm({ ...emptyModelForm(), providerId: provider.id });
    setView('models');
    setError('');
  }

  function beginModelEdit(item: AdminModel) {
    setEditingModelId(item.id);
    const video = item.mediaKind === 'VIDEO';
    const existingTiers = item.resolutionTiers.map((tier) => ({
      label: tier.label,
      shortEdge: String(tier.shortEdge),
      multiplier: String(item.pointMultipliers?.[tier.label] ?? 1),
    }));
    const tierRows = existingTiers.length
      ? existingTiers
      : (video ? item.allowedQualities : []).map((quality) => ({
          label: quality,
          shortEdge: '',
          multiplier: String(item.pointMultipliers?.[quality] ?? 1),
        }));
    setModelForm({
      providerId: item.providerId,
      mediaKind: video ? 'VIDEO' : 'IMAGE',
      adapterKind: item.adapterKind,
      displayName: item.displayName,
      upstreamModelId: item.upstreamModelId,
      allowedSizes: video ? item.allowedSizes.join(',') : '',
      tierRows: tierRows.length ? tierRows : (video ? DEFAULT_VIDEO_TIER_ROWS : DEFAULT_TIER_ROWS).map((row) => ({ ...row })),
      allowedRatios: video ? '' : item.allowedRatios.join(','),
      allowedQualities: item.allowedQualities.join(','),
      allowedDurations: item.allowedDurations.join(','),
      supportsEdit: item.supportsEdit,
      supportsInpaint: item.supportsInpaint,
      supportsFirstLastFrame: item.supportsFirstLastFrame,
      maxImages: item.maxImages,
      maxInputImages: item.maxInputImages,
      costPerUnit: String(item.costPerUnit),
      allowedGroupIds: item.allowedGroups.map(({ groupId }) => groupId),
    });
    setError('');
  }

  function updateTierRow(index: number, field: keyof TierRowInput, value: string) {
    setModelForm({ ...modelForm, tierRows: modelForm.tierRows.map((row, i) => i === index ? { ...row, [field]: value } : row) });
  }

  function addTierRow() {
    setModelForm({ ...modelForm, tierRows: [...modelForm.tierRows, { label: '', shortEdge: '', multiplier: '' }] });
  }

  function removeTierRow(index: number) {
    setModelForm({ ...modelForm, tierRows: modelForm.tierRows.filter((_, i) => i !== index) });
  }

  async function saveModel(event: FormEvent) {
    event.preventDefault();
    const updating = Boolean(editingModelId);
    const video = isVideoAdapter(modelForm.adapterKind);
    const tierLabelCount = modelForm.tierRows.filter((row) => row.label.trim()).length;
    const tierEdgeCount = modelForm.tierRows.filter((row) => row.shortEdge.trim()).length;
    if (tierLabelCount !== tierEdgeCount) {
      setError(t('分辨率名称与短边像素数量必须一致'));
      return;
    }
    const tierPairs = zipTierRows(modelForm.tierRows);
    const tierLabels = tierPairs.map((tier) => tier.label);
    const typedQualities = modelForm.allowedQualities.split(',').map((item) => item.trim()).filter(Boolean);
    const resolutionOptions = video ? (tierLabels.length ? tierLabels : typedQualities) : tierLabels;
    const multipliers = tierPairs.map((tier) => tier.multiplier);
    const pointMultipliers: Record<string, number> = {};
    resolutionOptions.forEach((option, index) => {
      const raw = multipliers[index];
      if (!raw) return;
      const number = Number(raw);
      if (Number.isFinite(number) && number > 0 && number <= 100) pointMultipliers[option] = number;
    });
    const sizes = modelForm.allowedSizes.split(',').map((item) => item.trim()).filter(Boolean);
    const ratios = modelForm.allowedRatios.split(',').map((item) => item.trim()).filter(Boolean);
    const durations = modelForm.allowedDurations.split(',').map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item > 0);
    const { tierRows: tierRowsForm, ...formRest } = modelForm;
    const payload = {
      ...formRest,
      allowedSizes: video ? (sizes.length ? sizes : ['16:9']) : [],
      resolutionTiers: tierPairs.map((tier) => ({ label: tier.label, shortEdge: tier.shortEdge })),
      allowedRatios: video ? [] : ratios,
      allowedQualities: video ? (resolutionOptions.length ? resolutionOptions : ['720P', '1080P']) : (typedQualities.length ? typedQualities : ['auto', 'low', 'medium', 'high']),
      allowedDurations: video ? (durations.length ? durations : [5, 10]) : durations,
      supportsInpaint: modelForm.adapterKind === 'openai-images' && modelForm.supportsInpaint,
      supportsFirstLastFrame: video && modelForm.supportsFirstLastFrame,
      costPerUnit: Math.max(1, Number(modelForm.costPerUnit) || 1),
      pointMultipliers: Object.keys(pointMultipliers).length ? pointMultipliers : null,
    };
    setError('');
    try {
      if (editingModelId) await api(`/admin/models/${editingModelId}`, json('PATCH', payload));
      else await api('/admin/models', json('POST', payload));
      cancelModelEdit();
      await refreshModels();
      notify('success', updating ? t('模型修改已保存') : t('模型保存成功'));
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message); notify('error', `${t('保存失败：')}${message}`);
    }
  }

  async function deleteModel(item: AdminModel) {
    if (!confirm(`${t('永久删除模型')}“${item.displayName}”？${t('历史生成记录会保留。')}`)) return;
    try {
      await api(`/admin/models/${item.id}`, json('DELETE'));
      if (editingModelId === item.id) cancelModelEdit();
      await refreshModels();
    } catch (caught) { setError((caught as Error).message); }
  }

  function cancelGroupEdit() {
    setEditingGroupId(''); setGroupForm(emptyGroupForm());
  }

  function beginGroupEdit(group: UserGroup) {
    setEditingGroupId(group.id); setGroupForm({ name: group.name, description: group.description ?? '', quotaWindow: group.quotaWindow ?? '', quotaPoints: group.quotaPoints != null ? String(group.quotaPoints) : '' }); setError('');
  }

  async function saveGroup(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      const payload = { name: groupForm.name, description: groupForm.description || null, quotaWindow: groupForm.quotaWindow.trim() || null, quotaPoints: groupForm.quotaPoints.trim() ? Number(groupForm.quotaPoints) : null };
      if (editingGroupId) await api(`/admin/user-groups/${editingGroupId}`, json('PATCH', payload));
      else await api('/admin/user-groups', json('POST', payload));
      const updating = Boolean(editingGroupId); cancelGroupEdit(); await refreshGroups();
      notify('success', updating ? t('用户组修改已保存') : t('用户组创建成功'));
    } catch (caught) { const message = (caught as Error).message; setError(message); notify('error', `${t('保存失败：')}${message}`); }
  }

  async function deleteGroup(group: UserGroup) {
    if (!confirm(`${t('删除用户组')}“${group.name}”？`)) return;
    try { await api(`/admin/user-groups/${group.id}`, json('DELETE')); if (editingGroupId === group.id) cancelGroupEdit(); await refreshGroups(); }
    catch (caught) { setError((caught as Error).message); }
  }

  async function updateUserGroups(user: AdminUser, groupId: string, checked: boolean) {
    const current = user.groups.map(({ id }) => id);
    const groupIds = checked ? [...current, groupId] : current.filter((id) => id !== groupId);
    try { await api(`/admin/users/${user.id}/groups`, json('PATCH', { groupIds })); await refreshGroups(); }
    catch (caught) { setError((caught as Error).message); }
  }

  function cancelTeamEdit() {
    setEditingTeamId(''); setTeamForm(emptyTeamForm());
  }

  function beginTeamEdit(team: WorkTeam) {
    setEditingTeamId(team.id); setTeamForm({ name: team.name, description: team.description ?? '' }); setError('');
  }

  async function saveTeam(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      const payload = { name: teamForm.name, description: teamForm.description || null };
      if (editingTeamId) await api(`/admin/work-teams/${editingTeamId}`, json('PATCH', payload));
      else await api('/admin/work-teams', json('POST', payload));
      const updating = Boolean(editingTeamId); cancelTeamEdit(); await refreshTeams();
      notify('success', updating ? t('工作团队修改已保存') : t('工作团队创建成功'));
    } catch (caught) { const message = (caught as Error).message; setError(message); notify('error', `${t('保存失败：')}${message}`); }
  }

  async function deleteTeam(team: WorkTeam) {
    if (!confirm(`${t('删除工作团队')}“${team.name}”？`)) return;
    try { await api(`/admin/work-teams/${team.id}`, json('DELETE')); if (editingTeamId === team.id) cancelTeamEdit(); await refreshTeams(); }
    catch (caught) { setError((caught as Error).message); }
  }

  async function updateUserTeams(user: AdminUser, teamId: string, checked: boolean) {
    const current = user.teams.map(({ id }) => id);
    const teamIds = checked ? [...current, teamId] : current.filter((id) => id !== teamId);
    try { await api(`/admin/users/${user.id}/teams`, json('PATCH', { teamIds })); await refreshTeams(); }
    catch (caught) { setError((caught as Error).message); }
  }

  function toggleModelGroup(groupId: string, checked: boolean) {
    setModelForm((current) => ({ ...current, allowedGroupIds: checked ? [...current.allowedGroupIds, groupId] : current.allowedGroupIds.filter((id) => id !== groupId) }));
  }

  async function saveSessionDuration(event: FormEvent) {
    event.preventDefault(); setSavingSessionDuration(true); setError('');
    try {
      const result = await api<{ duration: string }>('/admin/settings/session-duration', json('PATCH', { duration: sessionDuration.trim().toLowerCase() }));
      setSessionDuration(result.duration);
      notify('success', t('保存成功'));
    } catch (caught) { const message = (caught as Error).message; setError(message); notify('error', `${t('保存失败：')}${message}`); }
    finally { setSavingSessionDuration(false); }
  }

  async function saveTrashRetention(event: FormEvent) {
    event.preventDefault(); setSavingTrashRetention(true); setError('');
    try {
      const result = await api<{ duration: string }>('/admin/settings/trash-retention', json('PATCH', { duration: trashRetention.trim().toLowerCase() }));
      setTrashRetention(result.duration);
      notify('success', t('保存成功'));
    } catch (caught) { const message = (caught as Error).message; setError(message); notify('error', `${t('保存失败：')}${message}`); }
    finally { setSavingTrashRetention(false); }
  }

  async function saveUploadImage(event: FormEvent) {
    event.preventDefault(); setSavingUploadImage(true); setError('');
    try {
      const result = await api<{ maxLongEdge: number }>('/admin/settings/upload-image', json('PATCH', { maxLongEdge: uploadMaxLongEdge }));
      setUploadMaxLongEdge(result.maxLongEdge);
      notify('success', t('保存成功'));
    } catch (caught) { const message = (caught as Error).message; setError(message); notify('error', `${t('保存失败：')}${message}`); }
    finally { setSavingUploadImage(false); }
  }

  async function updateUserStatus(user: AdminUser, status: 'ACTIVE' | 'DISABLED') {
    try {
      await api(`/admin/users/${user.id}/status`, json('PATCH', { status }));
      await refreshUsers();
    } catch (caught) { setError((caught as Error).message); }
  }

  async function loadMoreUsers() {
    if (!userCursor) return;
    try {
      const page = await api<CursorPage<AdminUser>>(`/admin/users?cursor=${encodeURIComponent(userCursor)}`);
      setUsers((current) => [...current, ...page.items]);
      setUserCursor(page.nextCursor);
    } catch (caught) { setError((caught as Error).message); }
  }

  async function resetPassword(user: AdminUser) {
    const password = prompt(`${t('为用户设置新密码')} ${user.username} (${t(passwordRequirement(user.role))})`);
    if (!password) return;
    try { await api(`/admin/users/${user.id}/reset-password`, json('POST', { password })); alert(t('密码已重置')); }
    catch (caught) { alert((caught as Error).message); }
  }

  async function resetMfa(user: AdminUser) {
    const actorCode = prompt(`${t('输入你自己的新 6 位动态码，以重置用户的 MFA')} ${user.username}`);
    if (!actorCode) return;
    try { await api(`/admin/users/${user.id}/reset-mfa`, json('POST', { actorCode })); alert(t('MFA 已重置，该用户的会话已撤销')); await refreshUsers(); }
    catch (caught) { alert((caught as Error).message); }
  }

  async function deleteUser(user: AdminUser) {
    if (!confirm(`${t('永久删除用户')} ${user.username} ${t('及其全部内容？')}`)) return;
    try { await api(`/admin/users/${user.id}`, json('DELETE')); await refreshUsers(); }
    catch (caught) { setError((caught as Error).message); }
  }

  async function toggleProvider(provider: Provider) {
    try { await api(`/admin/providers/${provider.id}`, json('PATCH', { enabled: !provider.enabled })); await refreshProviders(); }
    catch (caught) { setError((caught as Error).message); }
  }

  async function toggleModel(item: AdminModel) {
    try { await api(`/admin/models/${item.id}`, json('PATCH', { enabled: !item.enabled })); await refreshModels(); }
    catch (caught) { setError((caught as Error).message); }
  }

  if (!authorized) return <main className="auth-page">{t('加载中…')}</main>;
  const tierEditor = (
    <div className="tier-editor">
      <div className="tier-editor-head">
        <span>{t('分辨率名称')}</span>
        <span>{t('短边像素')}</span>
        <span>{t('分辨率倍率')}</span>
      </div>
      {modelForm.tierRows.map((row, index) => (
        <div className="tier-editor-row" key={index}>
          <input className="field" placeholder={t('例如 1K')} value={row.label} onChange={(event) => updateTierRow(index, 'label', event.target.value)} />
          <input className="field" inputMode="numeric" placeholder={t('例如 1024')} value={row.shortEdge} onChange={(event) => updateTierRow(index, 'shortEdge', event.target.value)} />
          <input className="field" inputMode="decimal" placeholder={t('缺省为 1')} value={row.multiplier} onChange={(event) => updateTierRow(index, 'multiplier', event.target.value)} />
          <button className="tier-editor-remove" type="button" aria-label={t('删除此行')} onClick={() => removeTierRow(index)}><Icon name="close" /></button>
        </div>
      ))}
      <button className="button tier-editor-add" type="button" onClick={addTierRow}><Icon name="plus" />{t('添加一行')}</button>
    </div>
  );

  return <div className="shell admin-shell">
    {notice && <div className={`admin-toast ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.message}</div>}
    <aside className="sidebar admin-sidebar">
      <h2 className="brand">OmniStudio</h2><p className="admin-nav-label">{t('管理后台')}</p>
      <nav className="sidebar-nav" aria-label={t('后台管理导航')}>
        <AdminNavButton active={view === 'users'} onClick={() => setView('users')} icon="users">{t('用户管理')}</AdminNavButton>
        <AdminNavButton active={view === 'groups'} onClick={() => setView('groups')} icon="group">{t('用户组')}</AdminNavButton>
        <AdminNavButton active={view === 'teams'} onClick={() => setView('teams')} icon="team">{t('工作团队')}</AdminNavButton>
        <AdminNavButton active={view === 'usage'} onClick={() => setView('usage')} icon="chart">{t('用量')}</AdminNavButton>
        <AdminNavButton active={view === 'providers'} onClick={() => setView('providers')} icon="server">{t('添加供应商')}</AdminNavButton>
        <AdminNavButton active={view === 'models'} onClick={() => setView('models')} icon="layers">{t('添加模型')}</AdminNavButton>
        <AdminNavButton active={view === 'labels'} onClick={() => setView('labels')} icon="text">{t('显示文案')}</AdminNavButton>
        <AdminNavButton active={view === 'style-presets'} onClick={() => setView('style-presets')} icon="image">{t('风格预设')}</AdminNavButton>
        <AdminNavButton active={view === 'prompt-polish'} onClick={() => setView('prompt-polish')} icon="sparkles">{t('提示词润色')}</AdminNavButton>
        <AdminNavButton active={view === 'security'} onClick={() => setView('security')} icon="shield">{t('安全')}</AdminNavButton>
      </nav>
      <button className="button admin-return" onClick={() => router.push('/')}>{t('返回工作台')}</button>
    </aside>

    <main className="main admin-main">
      <header className="topbar admin-topbar"><div><h1>{view === 'users' ? t('用户管理') : view === 'groups' ? t('用户组') : view === 'teams' ? t('工作团队') : view === 'usage' ? t('用量') : view === 'providers' ? t('添加供应商') : view === 'models' ? t('添加模型') : view === 'labels' ? t('显示文案') : view === 'style-presets' ? t('风格预设') : view === 'prompt-polish' ? t('提示词润色') : t('安全')}</h1><p className="muted">{view === 'security' ? t('管理你的管理员账号安全选项。') : view === 'prompt-polish' ? t('配置用于文生图、图片编辑和文生视频提示词润色的大语言模型。') : view === 'style-presets' ? t('管理工作台中的风格预设样张和提示词。') : view === 'usage' ? t('查看各用户在选定 UTC 日期范围内消耗的图片张数和视频秒数。重试会计入。') : view === 'labels' ? t('设置尺寸、比例、质量和时长在工作台中文/英文界面的显示名称。') : view === 'groups' ? t('用户组只控制模型访问和生成额度，不用于文件分享。') : view === 'teams' ? t('工作团队用于素材分享。成员可以把资产库中的文件分享给同团队的人。') : t('管理 OmniStudio 的访问权限、图片与视频生成能力。')}</p></div><LanguageSwitcher /></header>
      {error && <p className="error admin-error">{error}</p>}

      {view === 'users' && <section className="admin-section stack">
        <div className="card registration-card"><div><strong>{t('开放注册')}</strong><p className="muted">{t('允许新用户自行注册；新账号仍需管理员激活。')}</p></div><label className="switch"><input type="checkbox" checked={registration} onChange={async (event) => {
          const enabled = event.target.checked; setRegistration(enabled);
          try { await api('/admin/settings/registration', json('PATCH', { enabled })); notify('success', t('保存成功')); } catch (caught) { const message = (caught as Error).message; setRegistration(!enabled); setError(message); notify('error', `${t('保存失败：')}${message}`); }
        }} /><span aria-hidden="true" /></label></div>
        <form className="card registration-card session-duration-setting" onSubmit={saveSessionDuration}><div><strong>{t('普通用户记住登录有效期')}</strong><p className="muted">{t('填写整数加单位：h 小时、d 天、w 星期、m 月（30 天）。范围 1h–12m；管理员固定为 1d。')}</p></div><div className="admin-actions"><input className="field compact-field" value={sessionDuration} onChange={(event) => setSessionDuration(event.target.value)} placeholder={t('例如 7d')} pattern="[1-9][0-9]{0,2}[hHdDwWmM]" maxLength={4} required /><button className="button primary" disabled={savingSessionDuration}>{savingSessionDuration ? t('保存中…') : t('保存')}</button></div></form>
        <form className="card registration-card session-duration-setting" onSubmit={saveTrashRetention}><div><strong>{t('回收站留存时长')}</strong><p className="muted">{t('填写整数加单位：h 小时、d 天、w 星期、m 月（30 天）。删除的资产到期后永久移除。范围 1h–12m。')}</p></div><div className="admin-actions"><input className="field compact-field" value={trashRetention} onChange={(event) => setTrashRetention(event.target.value)} placeholder={t('例如 30d')} pattern="[1-9][0-9]{0,2}[hHdDwWmM]" maxLength={4} required /><button className="button primary" disabled={savingTrashRetention}>{savingTrashRetention ? t('保存中…') : t('保存')}</button></div></form>
        <form className="card registration-card session-duration-setting" onSubmit={saveUploadImage}><div><strong>{t('上传图片最长边')}</strong><p className="muted">{t('参考图、原图和遮罩超过该像素边长时会按比例缩小后保存，不会放大。生成结果不受影响。')}</p></div><div className="admin-actions"><select className="field compact-field" value={uploadMaxLongEdge} onChange={(event) => setUploadMaxLongEdge(Number(event.target.value))} required>{(UPLOAD_MAX_LONG_EDGE_OPTIONS.includes(uploadMaxLongEdge) ? UPLOAD_MAX_LONG_EDGE_OPTIONS : [...UPLOAD_MAX_LONG_EDGE_OPTIONS, uploadMaxLongEdge].sort((left, right) => left - right)).map((edge) => <option key={edge} value={edge}>{edge} px</option>)}</select><button className="button primary" disabled={savingUploadImage}>{savingUploadImage ? t('保存中…') : t('保存')}</button></div></form>
        <section className="card admin-panel"><h2>{t('用户')}</h2><div className="table-scroll"><table><thead><tr><th>{t('用户名')}</th><th>{t('用户组')}</th><th>{t('工作团队')}</th><th>{t('状态')}</th><th>{t('存储')}</th><th>{t('操作')}</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}>
          <td>{user.username}<br /><span className="muted">{user.role}</span></td>
          <td>{user.role === 'ADMIN' ? <span className="muted">{t('全部模型')}</span> : user.groups.length ? user.groups.map(({ name }) => name).join('、') : <span className="muted">{t('未分组')}</span>}</td>
          <td>{user.role === 'ADMIN' ? <span className="muted">{t('可查看全部团队')}</span> : user.teams.length ? user.teams.map(({ name }) => name).join('、') : <span className="muted">{t('未加入团队')}</span>}</td>
          <td>{user.status}<br /><span className="muted">{user.mfaEnabled ? `MFA ${t('已启用')}` : user.mfaRequired ? `MFA ${t('待绑定')}` : `MFA ${t('未启用')}`}</span></td><td>{formatStorageBytes(user.storageBytes)}</td>
          <td><div className="admin-actions">{user.status !== 'ACTIVE' && <button className="button" onClick={() => void updateUserStatus(user, 'ACTIVE')}>{t('激活')}</button>}{user.status === 'ACTIVE' && <button className="button" onClick={() => void updateUserStatus(user, 'DISABLED')}>{t('禁用')}</button>}<button className="button" onClick={() => void resetPassword(user)}>{t('重置密码')}</button>{user.mfaEnabled && <button className="button" onClick={() => void resetMfa(user)}>{t('重置 MFA')}</button>}<button className="button danger" onClick={() => void deleteUser(user)}>{t('删除')}</button></div></td>
        </tr>)}</tbody></table></div>{userCursor && <button className="button" onClick={() => void loadMoreUsers()}>{t('加载更多用户')}</button>}</section>
      </section>}

      {view === 'groups' && <section className="admin-section admin-two-column">
        <section className={`card stack admin-panel ${editingGroupId ? 'editing-panel' : ''}`}><h2>{editingGroupId ? t('编辑用户组') : t('新建用户组')}</h2><form className="stack" onSubmit={saveGroup}>
          <input className="field" required maxLength={64} placeholder={t('用户组名称')} value={groupForm.name} onChange={(event) => setGroupForm({ ...groupForm, name: event.target.value })} />
          <textarea className="field" maxLength={300} placeholder={t('说明（可选）')} value={groupForm.description} onChange={(event) => setGroupForm({ ...groupForm, description: event.target.value })} />
          <label>{t('生成窗口')}<input className="field" value={groupForm.quotaWindow} maxLength={4} placeholder={t('例如 5h，留空表示不限额')} onChange={(event) => setGroupForm({ ...groupForm, quotaWindow: event.target.value })} /></label>
          <label>{t('窗口内每人积分')}<input className="field" value={groupForm.quotaPoints} inputMode="numeric" placeholder={t('例如 5，留空表示不限额')} onChange={(event) => setGroupForm({ ...groupForm, quotaPoints: event.target.value })} /></label>
          <p className="muted">{t('滑动窗口按积分计数，组内每人独立额度。图片按模型单价 × 张数，视频按单价 × 秒数。重试也计积分。窗口与积分必须同时填写或同时留空。')}</p>
          <div className="form-actions">{editingGroupId && <button className="button" type="button" onClick={cancelGroupEdit}>{t('取消')}</button>}<button className="button primary">{editingGroupId ? t('保存修改') : t('创建用户组')}</button></div>
        </form></section>
        <section className="card stack admin-panel"><h2>{t('已有用户组')}</h2>{groups.length === 0 && <p className="muted">{t('还没有用户组。')}</p>}{groups.map((group) => <div className="admin-list-item" key={group.id}><div><strong>{group.name}</strong><p className="muted">{group.description || t('无说明')} · {group._count.users}{t('位用户')} · {group._count.models}{t('个模型')} · {group.quotaWindow && group.quotaPoints != null ? `${group.quotaPoints}${t('积分')} / ${group.quotaWindow}` : t('不限额')}</p></div><div className="admin-actions"><button className="button" onClick={() => beginGroupEdit(group)}>{t('编辑')}</button><button className="button danger" onClick={() => void deleteGroup(group)}>{t('删除')}</button></div></div>)}</section>
        <section className="card stack admin-panel admin-span-full"><h2>{t('分配用户')}</h2><p className="muted">{t('用户可以同时属于多个组。修改后立即生效；管理员默认拥有全部模型权限。用户组不控制文件分享。')}</p>{users.map((user) => <div className="group-assignment-row" key={user.id}><div><strong>{user.displayName || user.username}</strong><p className="muted">@{user.username}</p></div><div className="permission-options">{user.role === 'ADMIN' ? <span className="muted">{t('管理员无需分组')}</span> : groups.length ? groups.map((group) => <label key={group.id}><input type="checkbox" checked={user.groups.some(({ id }) => id === group.id)} onChange={(event) => void updateUserGroups(user, group.id, event.target.checked)} /> {group.name}</label>) : <span className="muted">{t('请先创建用户组')}</span>}</div></div>)}{userCursor && <button className="button" onClick={() => void loadMoreUsers()}>{t('加载更多用户')}</button>}</section>
      </section>}

      {view === 'teams' && <section className="admin-section admin-two-column">
        <section className={`card stack admin-panel ${editingTeamId ? 'editing-panel' : ''}`}><h2>{editingTeamId ? t('编辑工作团队') : t('新建工作团队')}</h2><form className="stack" onSubmit={saveTeam}>
          <input className="field" required maxLength={64} placeholder={t('工作团队名称')} value={teamForm.name} onChange={(event) => setTeamForm({ ...teamForm, name: event.target.value })} />
          <textarea className="field" maxLength={300} placeholder={t('说明（可选）')} value={teamForm.description} onChange={(event) => setTeamForm({ ...teamForm, description: event.target.value })} />
          <p className="muted">{t('工作团队只用于素材分享，不影响模型权限和生成额度。')}</p>
          <div className="form-actions">{editingTeamId && <button className="button" type="button" onClick={cancelTeamEdit}>{t('取消')}</button>}<button className="button primary">{editingTeamId ? t('保存修改') : t('创建工作团队')}</button></div>
        </form></section>
        <section className="card stack admin-panel"><h2>{t('已有工作团队')}</h2>{teams.length === 0 && <p className="muted">{t('还没有工作团队。')}</p>}{teams.map((team) => <div className="admin-list-item" key={team.id}><div><strong>{team.name}</strong><p className="muted">{team.description || t('无说明')} · {team._count.users}{t('位用户')} · {team._count.assetShares ?? 0}{t('条分享')}</p></div><div className="admin-actions"><button className="button" onClick={() => beginTeamEdit(team)}>{t('编辑')}</button><button className="button danger" onClick={() => void deleteTeam(team)}>{t('删除')}</button></div></div>)}</section>
        <section className="card stack admin-panel admin-span-full"><h2>{t('分配用户')}</h2><p className="muted">{t('用户可以同时属于多个工作团队。修改后立即生效；成员可以把素材分享给同团队的人。')}</p>{users.map((user) => <div className="group-assignment-row" key={user.id}><div><strong>{user.displayName || user.username}</strong><p className="muted">@{user.username}</p></div><div className="permission-options">{user.role === 'ADMIN' ? <span className="muted">{t('管理员可查看全部团队')}</span> : teams.length ? teams.map((team) => <label key={team.id}><input type="checkbox" checked={user.teams.some(({ id }) => id === team.id)} onChange={(event) => void updateUserTeams(user, team.id, event.target.checked)} /> {team.name}</label>) : <span className="muted">{t('请先创建工作团队')}</span>}</div></div>)}{userCursor && <button className="button" onClick={() => void loadMoreUsers()}>{t('加载更多用户')}</button>}</section>
      </section>}

      {view === 'usage' && <section className="admin-section stack">
        <form className="card registration-card session-duration-setting" onSubmit={(event) => { event.preventDefault(); void refreshUsage(); }}>
          <div><strong>{t('UTC 日期范围')}</strong><p className="muted">{t('结束日期包含当天。账本从启用组配额后开始记录。')}</p></div>
          <div className="admin-actions">
            <input className="field compact-field" type="date" required value={usageFrom} onChange={(event) => setUsageFrom(event.target.value)} />
            <input className="field compact-field" type="date" required value={usageTo} onChange={(event) => setUsageTo(event.target.value)} />
            <button className="button primary" disabled={usageBusy}>{usageBusy ? t('加载中…') : t('查询')}</button>
          </div>
        </form>
        <section className="card admin-panel"><h2>{t('按用户')}</h2>
          <div className="table-scroll"><table><thead><tr><th>{t('用户名')}</th><th>{t('出图张数')}</th><th>{t('视频秒数')}</th><th>{t('积分')}</th><th>{t('扣减次数')}</th></tr></thead>
          <tbody>{usageRows.length ? usageRows.map((row) => <tr key={row.userId}><td>{row.displayName || row.username}<br /><span className="muted">@{row.username}</span></td><td>{row.imageCount}</td><td>{row.videoSeconds ?? 0}</td><td>{row.points}</td><td>{row.events}</td></tr>) : <tr><td colSpan={5} className="muted">{t('这段时间没有生成记录。')}</td></tr>}</tbody></table></div>
        </section>
      </section>}

      {view === 'providers' && <section className="admin-section admin-two-column">
        <section className={`card stack admin-panel ${editingProviderId ? 'editing-panel' : ''}`}><h2>{editingProviderId ? t('编辑供应商') : t('添加供应商')}</h2><form className="stack" onSubmit={saveProvider}>
          <input className="field" required placeholder={t('名称')} value={providerForm.name} onChange={(event) => setProviderForm({ ...providerForm, name: event.target.value })} />
          <input className="field" required placeholder={`${t('Base URL，例如')} https://api.openai.com/v1`} value={providerForm.baseUrl} onChange={(event) => setProviderForm({ ...providerForm, baseUrl: event.target.value })} />
          <input className="field" required={!editingProviderId} type="password" placeholder={editingProviderId ? t('API Key（留空表示不修改）') : t('API Key')} value={providerForm.apiKey} onChange={(event) => setProviderForm({ ...providerForm, apiKey: event.target.value })} />
          <label>{t('生成超时（秒）')}<input className="field" type="number" min="10" max="3600" value={providerForm.timeoutSeconds} onChange={(event) => setProviderForm({ ...providerForm, timeoutSeconds: Number(event.target.value) })} /></label>
          <label>{t('任务等待超时（秒）')}<input className="field" type="number" min="10" max="3600" value={providerForm.pollTimeoutSeconds} onChange={(event) => setProviderForm({ ...providerForm, pollTimeoutSeconds: Number(event.target.value) })} /></label>
          <p className="muted">{t('任务等待超时仅用于视频任务。同一账号的图片和视频模型可以共用一个供应商，Base URL 必须同时兼容这些模型的协议（例如 DashScope 或 OpenAI）。火山方舟与 OpenAI 不能填在同一个供应商里。')}</p>
          <div className="form-actions">{editingProviderId && <button className="button" type="button" onClick={cancelProviderEdit}>{t('取消')}</button>}<button className="button primary">{editingProviderId ? t('保存修改') : t('保存供应商')}</button></div>
        </form></section>
        <section className="card stack admin-panel"><h2>{t('已有供应商')}</h2>{providers.length === 0 && <p className="muted">{t('还没有供应商。')}</p>}{providers.map((provider) => <ProviderRow key={provider.id} provider={provider} now={clockNow} onEdit={beginProviderEdit} onModels={openProviderModels} onTest={testProvider} onToggle={toggleProvider} onDelete={deleteProvider} />)}</section>
      </section>}

      {view === 'models' && <section className="admin-section admin-two-column">
        <section className={`card stack admin-panel ${editingModelId ? 'editing-panel' : ''}`}><h2>{editingModelId ? t('编辑模型') : t('添加模型')}</h2><form className="stack" onSubmit={saveModel}>
          <select className="field" required value={modelForm.providerId} onChange={(event) => setModelForm({ ...modelForm, providerId: event.target.value })}>
            <option value="">{t('选择供应商')}</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
          </select>
          <label>{t('模型类型')}<select className="field" value={modelForm.mediaKind} onChange={(event) => {
            const mediaKind = event.target.value as MediaKind;
            const video = mediaKind === 'VIDEO';
            setModelForm({ ...modelForm, mediaKind, adapterKind: defaultAdapterForMedia(mediaKind), ...mediaFields(video) });
          }}>
            <option value="IMAGE">{t('图片')}</option>
            <option value="VIDEO">{t('视频')}</option>
          </select></label>
          <label>{t('适配器类型')}<select className="field" value={modelForm.adapterKind} onChange={(event) => {
            const adapterKind = event.target.value as AdapterKind;
            setModelForm({ ...modelForm, adapterKind, supportsInpaint: adapterKind === 'openai-images' ? modelForm.supportsInpaint : false });
          }}>
            {adaptersForMedia(modelForm.mediaKind).map((kind) => <option key={kind} value={kind}>{adapterLabel(kind, t)}</option>)}
          </select></label>
          {modelForm.adapterKind === 'wan' && <p className="muted">{t('Wan/HappyHorse 的 Base URL 优先填 https://dashscope.aliyuncs.com/api/v1。不要带 video-synthesis，也不要使用 compatible-mode。业务空间域名（*.maas.aliyuncs.com）在部分网络下会 TLS 握手失败。文生视频模型 ID 填 wan2.7-t2v 或 wan2.7-t2v-2026-06-12，分辨率填 720P / 1080P。')}</p>}
          {modelForm.adapterKind === 'veo' && <p className="muted">{t('Veo 的 Base URL 填 https://generativelanguage.googleapis.com/v1beta，API Key 使用 Google AI Studio 密钥。模型 ID 例如 veo-3.1-generate-preview 或 veo-3.1-fast-generate-preview。比例 16:9 / 9:16，分辨率 720p / 1080p / 4k，时长常见 4、6、8 秒。图生视频用第一张图作为首帧。')}</p>}
          {modelForm.adapterKind === 'minimax' && <p className="muted">{t('MiniMax 的 Base URL 国内填 https://api.minimaxi.com，国际填 https://api.minimax.io。模型 ID 填 MiniMax-H3。分辨率 768P / 2K，时长 4–15 秒。文生视频需指定比例；图生视频用第一张图作为首帧，第二张图作为尾帧。')}</p>}
          {modelForm.adapterKind === 'qwen-image' && <p className="muted">{t('Qwen/Wan 的 Base URL 填 https://dashscope.aliyuncs.com/api/v1，不要带 compatible-mode。模型 ID 例如 qwen-image-3.0、qwen-image-2.0-pro、qwen-image-plus。支持文生图与参考图编辑（最多 3 张参考图），不支持蒙版重绘；分辨率档位建议不超过 1K（总像素上限 2048×2048）。')}</p>}
          {modelForm.adapterKind === 'nano-banana' && <p className="muted">{t('Nano Banana 的 Base URL 填 https://generativelanguage.googleapis.com/v1beta，API Key 使用 Google AI Studio 密钥。模型 ID 例如 gemini-3.1-flash-image、gemini-3-pro-image、gemini-2.5-flash-image。支持文生图与参考图编辑（最多 14 张），不支持蒙版重绘。档位会映射为 512 / 1K / 2K / 4K。')}</p>}
          {modelForm.adapterKind === 'seedream' && <p className="muted">{t('Seedream 的 Base URL 填 https://ark.cn-beijing.volces.com/api/v3，可与 Seedance 共用同一供应商。模型 ID 例如 doubao-seedream-4-0-250828、doubao-seedream-4-5-251128、doubao-seedream-5-0-260128。支持文生图与参考图编辑（最多 14 张），不支持蒙版重绘。档位会映射为 1K / 2K / 3K / 4K。')}</p>}
          {modelForm.adapterKind === 'midjourney' && <p className="muted">{t('Midjourney 无官方公开 API。Base URL 填兼容 midjourney-proxy 的网关根地址（不要带 /mj/submit/imagine）。模型 ID 可填 v7、v6.1 或 niji-6（会写入 --v / --niji）。支持文生图与图生图（参考图最多 5 张），不支持蒙版重绘。比例会追加 --ar。')}</p>}
          {modelForm.adapterKind === 'flux' && <p className="muted">{t('Flux 的 Base URL 填 https://api.bfl.ai（EU：https://api.eu.bfl.ai，US：https://api.us.bfl.ai），可与 Flux 视频共用同一供应商。API Key 来自 dashboard.bfl.ai。模型 ID 即 BFL 路径，例如 flux-2-pro、flux-2-pro-preview、flux-2-flex、flux-2-max、flux-kontext-pro。支持文生图与参考图编辑（最多 8 张），不支持蒙版重绘。尺寸为宽×高。')}</p>}
          {modelForm.adapterKind === 'runway-images' && <p className="muted">{t('Runway 生图的 Base URL 填 https://api.dev.runwayml.com，可与 Runway 视频共用同一供应商。模型 ID 例如 gen4_image、gen4_image_turbo。比例会映射为像素比（如 1024:1024、1920:1080）。支持文生图与参考图编辑（最多 3 张；gen4_image_turbo 需要参考图），不支持蒙版重绘。')}</p>}
          {modelForm.adapterKind === 'runway' && <p className="muted">{t('Runway 的 Base URL 填 https://api.dev.runwayml.com。模型 ID 例如 gen4.5、gen4_turbo、veo3.1。比例填 16:9 或像素比 1280:720。文生视频走 /v1/text_to_video，图生视频走 /v1/image_to_video（第一张为首帧，第二张为尾帧；gen4_turbo 仅支持图生视频）。')}</p>}
          {modelForm.adapterKind === 'flux-video' && <p className="muted">{t('Flux 视频的 Base URL 与生图相同（https://api.bfl.ai），可共用同一供应商。模型 ID 填 flux-3-video。文生视频 mode=t2v，图生视频 mode=i2v（第一张为首帧，第二张为尾帧）。分辨率 hd / fhd，时长 5–20 秒，比例 16:9 / 9:16 / 1:1 等。')}</p>}
          <input className="field" required placeholder={t('用户看到的名称')} value={modelForm.displayName} onChange={(event) => setModelForm({ ...modelForm, displayName: event.target.value })} />
          <input className="field" required placeholder={t('真实模型 ID')} value={modelForm.upstreamModelId} onChange={(event) => setModelForm({ ...modelForm, upstreamModelId: event.target.value })} />
          <label>{t('每单位消耗积分')}<input className="field" type="number" min="1" max="1000" value={modelForm.costPerUnit} onChange={(event) => setModelForm({ ...modelForm, costPerUnit: event.target.value })} /></label>
          <p className="muted">{t('图片')} = {t('积分/张')}，{t('视频')} = {t('积分/秒')} · {t('实际积分 = 基准积分 × 分辨率倍率，结果向上取整')}</p>
          {isVideoAdapter(modelForm.adapterKind) ? <>
            {tierEditor}
            <label>{t('比例')}<input className="field" placeholder={t('比例，逗号分隔；例如 16:9,9:16,1:1')} value={modelForm.allowedSizes} onChange={(event) => setModelForm({ ...modelForm, allowedSizes: event.target.value })} /></label>
            <input className="field" required placeholder={t('时长秒，逗号分隔；例如 5,10')} value={modelForm.allowedDurations} onChange={(event) => setModelForm({ ...modelForm, allowedDurations: event.target.value })} />
            <label>{t('单次最多参考图数量')} <input className="field" type="number" min={modelForm.supportsFirstLastFrame ? 2 : 1} max="8" value={modelForm.maxInputImages} onChange={(event) => setModelForm({ ...modelForm, maxInputImages: Number(event.target.value) })} /></label>
            <label><input type="checkbox" checked={modelForm.supportsEdit} onChange={(event) => setModelForm({ ...modelForm, supportsEdit: event.target.checked })} /> {t('图生视频')}</label>
            <label><input type="checkbox" checked={modelForm.supportsFirstLastFrame} onChange={(event) => {
              const supportsFirstLastFrame = event.target.checked;
              setModelForm({ ...modelForm, supportsFirstLastFrame, maxInputImages: supportsFirstLastFrame ? Math.max(2, modelForm.maxInputImages) : modelForm.maxInputImages });
            }} /> {t('首尾帧')}</label>
            {modelForm.supportsFirstLastFrame && <p className="muted">{t('开启后，工作台会提供首帧和尾帧两个槽位；适配器把第一张图作为首帧、第二张图作为尾帧。')}</p>}
          </> : <>
            {tierEditor}
            <label>{t('比例')}<input className="field" placeholder={t('比例，逗号分隔；例如 1:1,3:2,2:3,16:9')} value={modelForm.allowedRatios} onChange={(event) => setModelForm({ ...modelForm, allowedRatios: event.target.value })} /></label>
            <p className="muted">{t('比例与档位自由组合，例如 1K + 3:2 自动生成 1536x1024')}</p>
            <button className="button" type="button" onClick={() => setModelForm({ ...modelForm, tierRows: FULL_DEFAULT_TIER_ROWS.map((row) => ({ ...row })), allowedRatios: DEFAULT_RATIOS_TEXT })}>{t('填入默认档位与比例')}</button>
            <input className="field" required placeholder={t('质量，逗号分隔')} value={modelForm.allowedQualities} onChange={(event) => setModelForm({ ...modelForm, allowedQualities: event.target.value })} />
            <label>{t('单次生成数量上限')} <input className="field" type="number" min="1" max="4" value={modelForm.maxImages} onChange={(event) => setModelForm({ ...modelForm, maxImages: Number(event.target.value) })} /></label>
            <label>{t('单次最多参考图数量')} <input className="field" type="number" min="1" max="8" value={modelForm.maxInputImages} onChange={(event) => setModelForm({ ...modelForm, maxInputImages: Number(event.target.value) })} /></label>
            <label><input type="checkbox" checked={modelForm.supportsEdit} onChange={(event) => setModelForm({ ...modelForm, supportsEdit: event.target.checked })} /> {t('整图编辑')}</label>
            {modelForm.adapterKind === 'openai-images' && <>
              <label><input type="checkbox" checked={modelForm.supportsInpaint} onChange={(event) => setModelForm({ ...modelForm, supportsInpaint: event.target.checked })} /> {t('局部重绘')}</label>
              <p className="muted">{t('局部重绘走 OpenAI Images 的 /images/edits：原图加透明遮罩。遮罩只作用于第一张参考图；Qwen/Wan、Nano Banana、Seedream、Midjourney、Flux、Runway 不支持蒙版。')}</p>
            </>}
          </>}
          <fieldset className="permission-fieldset"><legend>{t('可用用户组')}</legend><p className="muted">{t('不勾选表示模型为私有，仅管理员可用；管理员始终拥有访问权限。')}</p><div className="permission-options">{groups.map((group) => <label key={group.id}><input type="checkbox" checked={modelForm.allowedGroupIds.includes(group.id)} onChange={(event) => toggleModelGroup(group.id, event.target.checked)} /> {group.name}</label>)}{groups.length === 0 && <span className="muted">{t('尚未创建用户组')}</span>}</div></fieldset>
          <div className="form-actions">{editingModelId && <button className="button" type="button" onClick={cancelModelEdit}>{t('取消')}</button>}<button className="button primary">{editingModelId ? t('保存修改') : t('保存模型')}</button></div>
        </form></section>
        <section className="card stack admin-panel"><h2>{t('已有模型')}</h2>{models.length === 0 && <p className="muted">{t('还没有模型。')}</p>}{models.map((item) => <div className="admin-list-item" key={item.id}><div><strong>{item.displayName}</strong><p className="muted">{item.mediaKind === 'VIDEO' ? t('视频') : t('图片')} · {adapterLabel(item.adapterKind, t)} · {item.provider.name}/{item.upstreamModelId} · {item.enabled ? t('启用') : t('停用')}<br />{t('权限')}：{item.allowedGroups.length ? item.allowedGroups.map(({ group }) => group.name).join('、') : t('仅管理员（私有）')}{item.mediaKind === 'VIDEO'
            ? <><br />{t('分辨率')}：{(item.resolutionTiers.length ? item.resolutionTiers.map((tier) => `${tier.label}:${tier.shortEdge}`) : item.allowedQualities).join('、')} · {t('比例')}：{item.allowedSizes.join('、')}</>
            : <><br />{t('分辨率')}：{item.resolutionTiers.map((tier) => `${tier.label}:${tier.shortEdge}`).join('、')} · {t('比例')}：{item.allowedRatios.join('、')}</>}</p></div><div className="admin-actions">
          <button className="button" onClick={() => beginModelEdit(item)}>{t('编辑')}</button><button className="button" onClick={() => void toggleModel(item)}>{item.enabled ? t('停用') : t('启用')}</button><button className="button danger" onClick={() => void deleteModel(item)}>{t('删除')}</button>
        </div></div>)}</section>
      </section>}
      {view === 'labels' && <OptionLabelsSettings onNotice={notify} onError={setError} />}
      {view === 'style-presets' && <StylePresetsSettings onNotice={notify} onError={setError} />}
      {view === 'prompt-polish' && <PromptPolishSettings onNotice={notify} onError={setError} />}
      {view === 'security' && currentUser && <SecuritySettings user={currentUser} />}
    </main>
  </div>;
}

function AdminNavButton({ active, icon, onClick, children }: { active: boolean; icon: IconName; onClick: () => void; children: React.ReactNode }) {
  return <button className={`button nav-button admin-nav-button ${active ? 'active' : ''}`} onClick={onClick}><span className="nav-button-label"><Icon name={icon} />{children}</span><Icon name="chevron-right" /></button>;
}

function ProviderRow({ provider, now, onEdit, onModels, onTest, onToggle, onDelete }: { provider: Provider; now: number; onEdit: (provider: Provider) => void; onModels: (provider: Provider) => void; onTest: (provider: Provider) => Promise<void>; onToggle: (provider: Provider) => Promise<void>; onDelete: (provider: Provider) => Promise<void> }) {
  const { t } = useI18n();
  const [testing, setTesting] = useState(false);
  const cooldown = provider.testCooldownUntil ? Math.max(0, Math.ceil((new Date(provider.testCooldownUntil).getTime() - now) / 1000)) : 0;

  async function test() {
    setTesting(true);
    try { await onTest(provider); }
    finally { setTesting(false); }
  }

  return <div className="admin-list-item"><div><strong>{provider.name}</strong><p className="muted">{provider.baseUrl} · {provider.enabled ? t('启用') : t('停用')} · {provider._count?.models ?? 0}{t('个模型')}</p></div><div className="admin-actions">
    <button className="button" onClick={() => onEdit(provider)}>{t('编辑')}</button>
    <button className="button" onClick={() => onModels(provider)}>{t('模型设置')}</button>
    <button className={`button ${cooldown > 0 && provider.lastTestOk === true ? 'test-success' : cooldown > 0 && provider.lastTestOk === false ? 'test-failure' : ''}`} disabled={testing || cooldown > 0} onClick={() => void test()}>{testing ? t('测试中…') : cooldown > 0 ? `${provider.lastTestOk === true ? t('测试成功') : provider.lastTestOk === false ? t('测试失败') : t('测试中')} ${cooldown}s` : t('测试')}</button>
    <button className="button" onClick={() => void onToggle(provider)}>{provider.enabled ? t('停用') : t('启用')}</button>
    <button className="button danger" onClick={() => void onDelete(provider)}>{t('删除')}</button>
  </div></div>;
}
