import { FormEvent, memo, useEffect, useMemo, useState } from 'react';
import { api, json } from '@/lib/api';
import GenerationSettings from '@/components/GenerationSettings';
import MaskCanvas from '@/components/MaskCanvas';
import PromptHistory from '@/components/PromptHistory';
import StylePresetPicker from '@/components/StylePresetPicker';
import { buildResolutionMatrix, firstImageSize, parseSize, type ResolutionTier } from '@/lib/resolution-options';
import { stylePresetById, stylePresetLabel, type StylePreset } from '@/lib/style-presets';
import { assignFrameRoles, firstLastReferences, isVideoGenerationMode, sameReferenceSelection, type Asset, type FrameRole, type GenerationCreated, type GenerationMode, type GenerationReuse, type MediaKind, type ReferenceSelection, type StudioModel } from '@/lib/studio-types';
import Icon from '@/components/Icon';
import Toast, { useToast } from '@/components/Toast';
import type { OptionLabelMap } from '@/lib/option-labels';
import { useI18n } from '@/lib/i18n';

function pointMultiplier(multipliers: Record<string, number> | null | undefined, key: string | undefined): number {
  if (!key) return 1;
  return multipliers?.[key] ?? 1;
}

/** 与 API tierLabelForSize 一致：按短边匹配分辨率档位。 */
function tierLabelForSize(tiers: ResolutionTier[], size: string): string | undefined {
  const parsed = parseSize(size);
  if (!parsed) return undefined;
  const shortEdge = Math.min(parsed.width, parsed.height);
  return tiers.find((tier) => tier.shortEdge === shortEdge)?.label;
}

type StudioComposerProps = {
  models: StudioModel[];
  optionLabels?: OptionLabelMap;
  conversationId: string;
  references: ReferenceSelection[];
  onReferencesChange: (references: ReferenceSelection[]) => void;
  reusePreset: GenerationReuse | null;
  onReuseConsumed: () => void;
  onCreated: (result: GenerationCreated) => Promise<void>;
};

function StudioComposer({ models, optionLabels = {}, conversationId, references, onReferencesChange, reusePreset, onReuseConsumed, onCreated }: StudioComposerProps) {
  const { t, locale } = useI18n();
  const { toast, showToast } = useToast();
  const [prompt, setPrompt] = useState('');
  const [stylePresetId, setStylePresetId] = useState('');
  const [stylePresets, setStylePresets] = useState<StylePreset[]>([]);
  const [modelId, setModelId] = useState('');
  const [mode, setMode] = useState<GenerationMode>('TEXT_TO_IMAGE');
  const [mediaKind, setMediaKind] = useState<MediaKind>('IMAGE');
  const [size, setSize] = useState('');
  const [quality, setQuality] = useState('');
  const [duration, setDuration] = useState(5);
  const [count, setCount] = useState(1);
  const [sourceInputKey, setSourceInputKey] = useState(0);
  const [maskFile, setMaskFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [polishBusy, setPolishBusy] = useState(false);
  const [polishPreview, setPolishPreview] = useState<{ sourcePrompt: string; polishedPrompt: string } | null>(null);
  const [error, setError] = useState('');
  const visibleModels = useMemo(() => models.filter((item) => item.mediaKind === mediaKind), [models, mediaKind]);
  const model = useMemo(() => visibleModels.find((item) => item.id === modelId), [visibleModels, modelId]);
  const video = mediaKind === 'VIDEO';
  const hasSource = references.length > 0;
  const maxInputImages = model?.maxInputImages ?? 8;
  const primaryReference = references[0];
  const firstLast = mode === 'FIRST_LAST_FRAME_TO_VIDEO';
  const { first: firstFrame, last: lastFrame } = firstLastReferences(references);

  useEffect(() => {
    if (model || !visibleModels[0]) return;
    chooseModel(visibleModels[0]);
  }, [visibleModels, model]);

  useEffect(() => {
    let cancelled = false;
    api<{ items: StylePreset[] }>('/style-presets')
      .then((result) => { if (!cancelled) setStylePresets(result.items); })
      .catch(() => { if (!cancelled) setStylePresets([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!stylePresetId || !stylePresets.length) return;
    if (!stylePresetById(stylePresets, stylePresetId)) setStylePresetId('');
  }, [stylePresetId, stylePresets]);

  useEffect(() => {
    if (!reusePreset) return;
    const targetModel = reusePreset.modelId ? models.find((item) => item.id === reusePreset.modelId) : undefined;
    const warnings: string[] = [];
    const nextKind: MediaKind = isVideoGenerationMode(reusePreset.mode) ? 'VIDEO' : 'IMAGE';
    setMediaKind(nextKind);
    setPrompt(reusePreset.prompt);
    setStylePresetId(reusePreset.stylePresetId ?? '');
    setMode(reusePreset.mode);
    onReferencesChange(reusePreset.sourceAssets.map((asset) => ({ key: 'reuse-' + asset.id, kind: 'asset', asset })));
    setMaskFile(null);
    setSourceInputKey((current) => current + 1);

    if (targetModel) {
      setModelId(targetModel.id);
      const videoModel = targetModel.mediaKind === 'VIDEO';
      const imageSizeOk = reusePreset.size && buildResolutionMatrix(targetModel.resolutionTiers, targetModel.allowedRatios)?.partsOf(reusePreset.size) != null;
      const nextSize = reusePreset.size && (videoModel ? targetModel.allowedSizes.includes(reusePreset.size) : imageSizeOk)
        ? reusePreset.size
        : (targetModel.defaults.size ?? (videoModel ? targetModel.allowedSizes[0] : firstImageSize(targetModel.resolutionTiers, targetModel.allowedRatios)));
      const nextQuality = reusePreset.quality && targetModel.allowedQualities.includes(reusePreset.quality) ? reusePreset.quality : targetModel.defaults.quality ?? targetModel.allowedQualities[0];
      const durations = targetModel.allowedDurations;
      const nextDuration = reusePreset.durationSeconds && durations.includes(reusePreset.durationSeconds) ? reusePreset.durationSeconds : targetModel.defaults.durationSeconds ?? durations[0] ?? 5;
      setSize(nextSize);
      setQuality(nextQuality);
      setDuration(nextDuration);
      setCount(Math.min(targetModel.maxImages, Math.max(1, reusePreset.count)));
      if (reusePreset.mode === 'IMAGE_EDIT' && !targetModel.supportsEdit || reusePreset.mode === 'INPAINT' && !targetModel.supportsInpaint) {
        setMode('TEXT_TO_IMAGE');
        warnings.push(t('历史任务的编辑模式已不再受当前模型支持，请重新选择模型。'));
      }
      if (reusePreset.mode === 'IMAGE_TO_VIDEO' && !targetModel.supportsEdit) {
        setMode(targetModel.supportsFirstLastFrame ? 'FIRST_LAST_FRAME_TO_VIDEO' : 'TEXT_TO_VIDEO');
        warnings.push(t('历史任务的图生视频已不再受当前模型支持，请重新选择模型。'));
      }
      if (reusePreset.mode === 'FIRST_LAST_FRAME_TO_VIDEO' && !targetModel.supportsFirstLastFrame) {
        setMode(targetModel.supportsEdit ? 'IMAGE_TO_VIDEO' : 'TEXT_TO_VIDEO');
        warnings.push(t('历史任务的首尾帧已不再受当前模型支持，请重新选择模型。'));
      }
    } else {
      warnings.push(t('历史任务使用的模型') + '“' + reusePreset.modelDisplayName + '”' + t('已不可用，请重新选择模型。'));
    }
    if (reusePreset.requiresMaskRedraw) warnings.push(t('参考图已恢复；局部重绘需要重新绘制遮罩。'));
    setError(warnings.join('\n'));
    onReuseConsumed();
  }, [models, onReferencesChange, onReuseConsumed, reusePreset, t]);

  useEffect(() => {
    if (!firstLast) {
      if (references.some((item) => item.frameRole)) onReferencesChange(references.map((item) => item.frameRole ? { ...item, frameRole: undefined } : item));
      return;
    }
    const next = assignFrameRoles(references);
    if (sameReferenceSelection(references, next)) return;
    if (references.length > next.length) setError(t('首尾帧只需首帧和尾帧各一张'));
    onReferencesChange(next);
  }, [firstLast, references, onReferencesChange, t]);

  function chooseModel(item: StudioModel) {
    setModelId(item.id);
    const videoModel = item.mediaKind === 'VIDEO';
    setSize(item.defaults.size ?? (videoModel ? item.allowedSizes[0] : firstImageSize(item.resolutionTiers, item.allowedRatios)));
    setQuality(item.defaults.quality ?? item.allowedQualities[0] ?? '');
    setDuration(item.defaults.durationSeconds ?? item.allowedDurations[0] ?? 5);
    setCount(item.defaults.count ?? 1);
    setMode((current) => {
      if (item.mediaKind === 'VIDEO') {
        if (current === 'FIRST_LAST_FRAME_TO_VIDEO' && item.supportsFirstLastFrame) return current;
        if (current === 'IMAGE_TO_VIDEO' && item.supportsEdit) return current;
        if (current === 'FIRST_LAST_FRAME_TO_VIDEO' && item.supportsEdit) return 'IMAGE_TO_VIDEO';
        if (current === 'IMAGE_TO_VIDEO' && item.supportsFirstLastFrame) return 'FIRST_LAST_FRAME_TO_VIDEO';
        return 'TEXT_TO_VIDEO';
      }
      return current === 'IMAGE_EDIT' && !item.supportsEdit || current === 'INPAINT' && !item.supportsInpaint ? 'TEXT_TO_IMAGE' : isVideoGenerationMode(current) ? 'TEXT_TO_IMAGE' : current;
    });
  }

  function resetComposer() {
    setPrompt('');
    setStylePresetId('');
    setPolishPreview(null);
    setMode(video ? 'TEXT_TO_VIDEO' : 'TEXT_TO_IMAGE');
    onReferencesChange([]);
    setMaskFile(null);
    setSourceInputKey((current) => current + 1);
    setError('');
    if (model) {
      setSize(model.defaults.size ?? (model.mediaKind === 'VIDEO' ? model.allowedSizes[0] : firstImageSize(model.resolutionTiers, model.allowedRatios)));
      setQuality(model.defaults.quality ?? model.allowedQualities[0]);
      setDuration(model.defaults.durationSeconds ?? model.allowedDurations[0] ?? 5);
      setCount(model.defaults.count ?? 1);
    }
  }

  function switchMediaKind(next: MediaKind) {
    if (next === mediaKind) return;
    setMediaKind(next);
    setModelId('');
    setMode(next === 'VIDEO' ? 'TEXT_TO_VIDEO' : 'TEXT_TO_IMAGE');
    setPolishPreview(null);
    onReferencesChange([]);
    setMaskFile(null);
    setError('');
  }

  async function polishPrompt() {
    const sourcePrompt = prompt.trim();
    if (!sourcePrompt) {
      showToast('error', t('提示词不能为空'));
      return;
    }
    const editing = mode === 'IMAGE_EDIT';
    if (editing && !primaryReference) {
      showToast('error', t('请选择或上传一张原图'));
      return;
    }
    if (editing ? !confirm(t('确定润色当前提示词？将调用润色模型改写内容，并把当前参考图作为润色的一部分发送给模型。')) : !confirm(t('确定润色当前提示词？将调用润色模型改写内容。'))) return;
    setPolishBusy(true);
    setError('');
    try {
      let sourceAssetId: string | undefined;
      if (editing) {
        const asset = primaryReference.kind === 'file' ? await upload(primaryReference.file) : primaryReference.asset;
        sourceAssetId = asset.id;
      }
      const result = await api<{ polishedPrompt: string }>('/prompt-polish', json('POST', {
        prompt: sourcePrompt,
        mode: video || firstLast ? 'TEXT_TO_VIDEO' : editing ? 'IMAGE_EDIT' : 'TEXT_TO_IMAGE',
        ...(sourceAssetId ? { sourceAssetId } : {}),
      }));
      setPolishPreview({ sourcePrompt, polishedPrompt: result.polishedPrompt });
    } catch (caught) {
      showToast('error', t((caught as Error).message));
    } finally {
      setPolishBusy(false);
    }
  }

  function applyPolishedPrompt() {
    if (!polishPreview) return;
    if (prompt.trim() !== polishPreview.sourcePrompt) {
      setError(t('提示词在预览期间已发生变化，请重新润色'));
      setPolishPreview(null);
      return;
    }
    if (!confirm(t('确定用润色结果替换当前提示词？'))) return;
    setPrompt(polishPreview.polishedPrompt);
    setPolishPreview(null);
    setError('');
  }

  async function upload(file: File, role: 'UPLOAD' | 'MASK' = 'UPLOAD') {
    const form = new FormData();
    form.set('file', file);
    form.set('role', role);
    return api<Asset>('/uploads', { method: 'POST', body: form });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if ((mode === 'TEXT_TO_IMAGE' || mode === 'TEXT_TO_VIDEO') && hasSource) {
      setError(t('已选参考图') + '，' + (video ? videoSourceHint(model, t) : t('请切换到整图编辑或局部重绘')) + '。');
      return;
    }
    if (firstLast && (!firstFrame || !lastFrame)) {
      setError(t('首尾帧必须提供首帧和尾帧'));
      return;
    }
    if (mode !== 'TEXT_TO_IMAGE' && mode !== 'TEXT_TO_VIDEO' && !firstLast && !hasSource) {
      setError(t('原图') + '：' + t('请选择或上传一张原图'));
      return;
    }
    if (references.length > maxInputImages) {
      setError(t('当前参考图数量') + ' ' + references.length + ' ' + t('已超过模型上限') + ' ' + maxInputImages + '。');
      return;
    }
    if (mode === 'INPAINT' && !maskFile) {
      setError(t('请先绘制并使用遮罩') + '。');
      return;
    }
    setBusy(true);
    try {
      const orderedReferences = firstLast ? [firstFrame, lastFrame].filter((item): item is ReferenceSelection => Boolean(item)) : references;
      const uploadedReferences = await Promise.all(orderedReferences.map(async (reference) => reference.kind === 'file' ? upload(reference.file) : reference.asset));
      const sourceAssetIds = firstLast ? uploadedReferences.map((asset) => asset.id) : [...new Set(uploadedReferences.map((asset) => asset.id))];
      const uploadedMask = mode === 'INPAINT' && maskFile ? await upload(maskFile, 'MASK') : undefined;
      const result = await api<GenerationCreated>('/generations', json('POST', {
        conversationId: conversationId || undefined,
        modelId,
        prompt,
        mode,
        size,
        quality,
        count,
        ...(video ? { durationSeconds: duration } : {}),
        sourceAssetIds,
        maskAssetId: uploadedMask?.id,
        ...(!video && (mode === 'TEXT_TO_IMAGE' || mode === 'IMAGE_EDIT') && stylePresetId ? { stylePresetId } : {}),
      }));
      resetComposer();
      await onCreated(result);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function removeReference(key: string) {
    onReferencesChange(references.filter((reference) => reference.key !== key));
    setMaskFile(null);
    setError('');
  }

  function setFrame(role: FrameRole, value: ReferenceSelection | null) {
    const current = assignFrameRoles(references);
    const nextFirst = role === 'first' ? value : current.find((item) => item.frameRole === 'first');
    const nextLast = role === 'last' ? value : current.find((item) => item.frameRole === 'last');
    const next: ReferenceSelection[] = [];
    if (nextFirst) next.push({ ...nextFirst, frameRole: 'first' });
    if (nextLast) next.push({ ...nextLast, frameRole: 'last' });
    onReferencesChange(next);
    setError('');
  }

  function addFrameFile(role: FrameRole, file: File) {
    setFrame(role, { key: 'file-' + Date.now() + '-' + role + '-' + file.name, kind: 'file', file, frameRole: role });
  }

  function addFiles(files: File[]) {
    const available = Math.max(0, maxInputImages - references.length);
    if (!available) {
      setError(t('已达到该模型的参考图上限') + ' ' + maxInputImages + '。');
      return;
    }
    const accepted = files.slice(0, available);
    if (accepted.length < files.length) setError(t('仅添加了前') + ' ' + accepted.length + ' ' + t('张参考图，已达到模型上限') + ' ' + maxInputImages + '。');
    onReferencesChange([...references, ...accepted.map((file, index) => ({ key: 'file-' + Date.now() + '-' + index + '-' + file.name, kind: 'file' as const, file }))]);
    setMaskFile(null);
  }

  const maskSource = primaryReference?.kind === 'asset' ? (primaryReference.asset.thumbnailUrl ?? primaryReference.asset.contentUrl) : primaryReference?.file;
  const estimatedPoints = useMemo(() => {
    if (!model) return 0;
    if (video) {
      const multiplier = pointMultiplier(model.pointMultipliers, quality || undefined);
      return Math.ceil(model.costPerUnit * duration * multiplier);
    }
    const multiplier = pointMultiplier(model.pointMultipliers, tierLabelForSize(model.resolutionTiers, size));
    return Math.ceil(model.costPerUnit * count * multiplier);
  }, [model, video, quality, duration, size, count]);
  const stylePickerVisible = !video && (mode === 'TEXT_TO_IMAGE' || mode === 'IMAGE_EDIT');
  const restyleOnly = mode === 'IMAGE_EDIT' && Boolean(stylePresetId);
  const selectedStyle = stylePresetById(stylePresets, stylePresetId);
  const promptPlaceholder = video ? t('输入视频描述或镜头要求') : restyleOnly ? t('可选：额外的编辑要求，或留空只转风格') : t('输入图片描述或编辑要求');

  return <form className={'composer card stack ' + (conversationId ? 'compact-composer' : '')} onSubmit={submit}>
    <Toast toast={toast} />
    <h1>{t('想创作什么？')}</h1>
    <div className="media-kind-tabs" role="tablist" aria-label={t('创作类型')}>
      <button className={mediaKind === 'IMAGE' ? 'active' : ''} type="button" role="tab" aria-selected={mediaKind === 'IMAGE'} onClick={() => switchMediaKind('IMAGE')}>{t('图片')}</button>
      <button className={mediaKind === 'VIDEO' ? 'active' : ''} type="button" role="tab" aria-selected={mediaKind === 'VIDEO'} onClick={() => switchMediaKind('VIDEO')}>{t('视频')}</button>
    </div>
    {video && !visibleModels.length && <p className="muted">{t('还没有可用的视频模型，请联系管理员接入供应商并授权。')}</p>}
    <div className="prompt-input-wrap">
      <textarea className="field prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={promptPlaceholder} required={!restyleOnly} />
      <div className="prompt-input-actions">
        <PromptHistory onPick={(value) => { setPrompt(value); setPolishPreview(null); }} />
        {(mode === 'TEXT_TO_IMAGE' || mode === 'TEXT_TO_VIDEO' || firstLast || (mode === 'IMAGE_EDIT' && hasSource)) && <button className="button prompt-polish-button" type="button" disabled={polishBusy || busy || !prompt.trim()} onClick={() => void polishPrompt()}>{polishBusy ? t('正在润色…') : t('提示词润色')}</button>}
      </div>
    </div>
    {stylePickerVisible && <StylePresetPicker value={stylePresetId} items={stylePresets} onChange={setStylePresetId} />}
    {polishPreview && <section className="prompt-polish-preview" aria-live="polite">
      <div className="prompt-polish-preview-block"><span className="prompt-polish-preview-label">{t('原提示词')}</span><p>{polishPreview.sourcePrompt}</p></div>
      <div className="prompt-polish-preview-block"><span className="prompt-polish-preview-label">{t('润色结果')}</span><p>{polishPreview.polishedPrompt}</p></div>
      <div className="prompt-polish-preview-actions"><button className="button primary" type="button" onClick={applyPolishedPrompt}>{t('应用润色')}</button><button className="button" type="button" onClick={() => setPolishPreview(null)}>{t('取消润色')}</button></div>
    </section>}
    {firstLast && <div className="frame-slots" aria-label={t('首尾帧')}>
      <FrameSlot role="first" reference={firstFrame} t={t} onFile={(file) => addFrameFile('first', file)} onClear={() => setFrame('first', null)} />
      <FrameSlot role="last" reference={lastFrame} t={t} onFile={(file) => addFrameFile('last', file)} onClear={() => setFrame('last', null)} />
      <p className="muted frame-slots-hint">{t('请分别指定视频的首帧和尾帧')}</p>
    </div>}
    {!firstLast && hasSource && <div className="source-selection-list" aria-label={t('参考图列表')}>
      {references.map((reference, index) => <div className="source-selection" key={reference.key}>
        {reference.kind === 'asset' && reference.asset.thumbnailUrl ? <img src={reference.asset.thumbnailUrl} width={reference.asset.thumbnailWidth ?? undefined} height={reference.asset.thumbnailHeight ?? undefined} alt={t('已选参考图')} /> : <Icon className="source-file-icon" name="image" />}
        <div className="source-selection-copy"><strong>{index + 1}. {reference.kind === 'asset' ? reference.asset.visibility === 'shared' ? t('组内参考图') : t('已选历史参考图') : reference.file.name}</strong><span className="muted">{reference.kind === 'asset' ? reference.asset.visibility === 'shared' ? t('组内素材') : t('已保存图片') : t('本地图片')}</span></div>
        <button className="icon-button" type="button" onClick={() => removeReference(reference.key)} aria-label={t('移除参考图')} title={t('移除')}><Icon name="close" /></button>
      </div>)}
      <p className="muted reference-limit">{t('参考图数量')}：{references.length}/{maxInputImages}</p>
    </div>}
    {mode !== 'TEXT_TO_IMAGE' && mode !== 'TEXT_TO_VIDEO' && !firstLast && <label className="source-upload">{t('添加参考图')}（{t('可多选')}）
      <input key={sourceInputKey} className="field" type="file" accept="image/png,image/jpeg,image/webp" multiple required={!hasSource} onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ''; }} />
    </label>}
    {mode === 'INPAINT' && maskSource && <MaskCanvas imageSource={maskSource} onMask={setMaskFile} />}
    <div className="composer-controls">
      <select className="field compact-field" value={modelId} onChange={(event) => { const found = visibleModels.find((item) => item.id === event.target.value); if (found) chooseModel(found); }} required><option value="">{t('选择模型')}</option>{visibleModels.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select>
      <select className="field compact-field" value={mode} onChange={(event) => { const nextMode = event.target.value as GenerationMode; setMode(nextMode); if (nextMode !== 'TEXT_TO_IMAGE' && nextMode !== 'TEXT_TO_VIDEO') setPolishPreview(null); setError(''); }}>
        {video ? <>
          <option value="TEXT_TO_VIDEO">{t('文生视频')}</option>
          {model?.supportsEdit && <option value="IMAGE_TO_VIDEO">{t('图生视频')}</option>}
          {model?.supportsFirstLastFrame && <option value="FIRST_LAST_FRAME_TO_VIDEO">{t('首尾帧')}</option>}
        </> : <>
          <option value="TEXT_TO_IMAGE">{t('文生图')}</option>
          {model?.supportsEdit && <option value="IMAGE_EDIT">{t('整图编辑')}</option>}
          {model?.supportsInpaint && <option value="INPAINT">{t('局部重绘')}</option>}
        </>}
      </select>
      <GenerationSettings
        kind={mediaKind}
        sizes={model?.allowedSizes ?? []}
      tiers={model?.resolutionTiers ?? []}
      ratios={model?.allowedRatios ?? []}
        qualities={model?.allowedQualities ?? []}
        durations={model?.allowedDurations ?? []}
        optionLabels={optionLabels}
        maxImages={model?.maxImages ?? 1}
        size={size}
        quality={quality}
        duration={duration}
        count={count}
        disabled={!model}
        onSizeChange={setSize}
        onQualityChange={setQuality}
        onDurationChange={setDuration}
        onCountChange={setCount}
      />
      <div className="generate-area">
        {stylePickerVisible && selectedStyle && <button className="style-preset-chip" type="button" onClick={() => setStylePresetId('')} aria-label={t('清除风格')}>
          {t('风格')}：{stylePresetLabel(selectedStyle, locale)}
          <Icon name="close" />
        </button>}
        {model && <span className="generate-cost">{t('预计消耗')} <strong>{estimatedPoints}</strong>{t('积分')}</span>}
        <button className="button primary generate-button" disabled={busy || !modelId || mode === 'INPAINT' && !maskFile}>{busy ? t('正在提交/生成…') : t('开始生成')}</button>
      </div>
    </div>
    {error && <p className="error composer-error">{error}</p>}
  </form>;
}

export default memo(StudioComposer);

function videoSourceHint(model: StudioModel | undefined, t: (key: string) => string) {
  if (model?.supportsEdit && model.supportsFirstLastFrame) return t('请切换到图生视频或首尾帧');
  if (model?.supportsFirstLastFrame) return t('请切换到首尾帧');
  return t('请切换到图生视频');
}

function FrameSlot({ role, reference, t, onFile, onClear }: {
  role: FrameRole;
  reference?: ReferenceSelection;
  t: (key: string) => string;
  onFile: (file: File) => void;
  onClear: () => void;
}) {
  const label = role === 'first' ? t('首帧') : t('尾帧');
  const filled = Boolean(reference);
  return <div className={'frame-slot' + (filled ? ' filled' : '')}>
    <div className="frame-slot-head">
      <strong>{label}</strong>
      {filled && <button className="icon-button" type="button" onClick={onClear} aria-label={role === 'first' ? t('移除首帧') : t('移除尾帧')} title={t('移除')}><Icon name="close" /></button>}
    </div>
    {reference?.kind === 'asset'
      ? (reference.asset.thumbnailUrl
        ? <img className="frame-slot-preview" src={reference.asset.thumbnailUrl} width={reference.asset.thumbnailWidth ?? undefined} height={reference.asset.thumbnailHeight ?? undefined} alt={label} />
        : <div className="frame-slot-empty"><span>{t('暂无预览')}</span></div>)
      : <div className="frame-slot-empty">{reference?.kind === 'file' ? <><Icon className="source-file-icon" name="image" /><span>{reference.file.name}</span></> : t('尚未选择')}</div>}
    <label className="source-upload">{filled ? t('更换图片') : (role === 'first' ? t('添加首帧') : t('添加尾帧'))}
      <input className="field" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) onFile(file); event.currentTarget.value = ''; }} />
    </label>
  </div>;
}
