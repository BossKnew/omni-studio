import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '@/lib/i18n';
import { optionLabelFor, type OptionLabelMap } from '@/lib/option-labels';
import { buildResolutionMatrix, type ResolutionTier } from '@/lib/resolution-options';
import type { MediaKind } from '@/lib/studio-types';
import Icon from '@/components/Icon';

type GenerationSettingsProps = {
  kind?: MediaKind;
  sizes: string[];
  tiers: ResolutionTier[];
  ratios: string[];
  qualities: string[];
  durations?: number[];
  optionLabels?: OptionLabelMap;
  maxImages: number;
  size: string;
  quality: string;
  duration?: number;
  count: number;
  disabled?: boolean;
  onSizeChange: (value: string) => void;
  onQualityChange: (value: string) => void;
  onDurationChange?: (value: number) => void;
  onCountChange: (value: number) => void;
};

const POPOVER_GAP = 10;
const POPOVER_MAX_HEIGHT = 440;

export default function GenerationSettings({
  kind = 'IMAGE',
  sizes,
  tiers,
  ratios,
  qualities,
  durations = [],
  optionLabels = {},
  maxImages,
  size,
  quality,
  duration,
  count,
  disabled = false,
  onSizeChange,
  onQualityChange,
  onDurationChange,
  onCountChange,
}: GenerationSettingsProps) {
  const { t, locale } = useI18n();
  const labelOf = (value: string) => optionLabelFor(optionLabels, value, locale);
  const durationLabel = (value: number) => labelOf(`${value}s`);
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const counts = Array.from({ length: Math.max(1, maxImages) }, (_, index) => index + 1);
  const video = kind === 'VIDEO';
  const matrix = useMemo(() => kind === 'IMAGE' ? buildResolutionMatrix(tiers, ratios) : null, [kind, tiers, ratios]);
  const active = matrix ? (matrix.partsOf(size) ?? matrix.entries[0]) : null;
  const selectTier = (tier: string) => {
    if (!matrix || !active) return;
    onSizeChange(matrix.sizeFor(tier, active.ratio) ?? matrix.sizesForTier(tier)[0]);
  };
  const selectRatio = (ratio: string) => {
    if (!matrix || !active) return;
    onSizeChange(matrix.sizeFor(active.tier, ratio) ?? matrix.sizesForRatio(ratio)[0]);
  };

  // 弹层优先在触发按钮上方展开；上方空间不足时翻转到下方，
  // 并限制最大高度，保证整个面板始终落在视口内（否则顶部会被裁掉）。
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!rootRef.current || !triggerRef.current) return;
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const above = triggerRect.top - POPOVER_GAP;
      const below = viewportHeight - triggerRect.bottom - POPOVER_GAP;
      const maxHeight = Math.min(POPOVER_MAX_HEIGHT, Math.floor(viewportHeight * 0.58), Math.max(0, Math.max(above, below)));
      if (below > above) {
        setPopoverStyle({ top: `calc(100% + ${POPOVER_GAP}px)`, bottom: 'auto', maxHeight });
      } else {
        setPopoverStyle({ top: 'auto', bottom: `calc(100% + ${POPOVER_GAP}px)`, maxHeight });
      }
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const summary = video
    ? `${size ? labelOf(size) : t('未选择')}${duration ? ` | ${durationLabel(duration)}` : ''}${qualities.length && quality ? ` | ${labelOf(quality)}` : ''}`
    : `${size ? labelOf(size) : t('未选择')} | ${quality ? labelOf(quality) : t('未选择')} | ${count}`;

  return <div className="generation-settings" ref={rootRef}>
    <button
      ref={triggerRef}
      className="field generation-settings-trigger"
      type="button"
      aria-expanded={open}
      aria-controls={panelId}
      aria-label={`${t('生成设置选项')}：${summary}`}
      disabled={disabled}
      onClick={() => setOpen((current) => !current)}
    >
      <Icon className="generation-settings-icon" name="sliders" />
      {video ? <>
        <span>{size ? labelOf(size) : '—'}</span>
        {duration ? <><span className="generation-settings-separator">|</span><span>{durationLabel(duration)}</span></> : null}
        {qualities.length ? <><span className="generation-settings-separator">|</span><span>{quality ? labelOf(quality) : '—'}</span></> : null}
      </> : <>
        <span>{size ? labelOf(size) : '—'}</span><span className="generation-settings-separator">|</span>
        <span>{quality ? labelOf(quality) : '—'}</span><span className="generation-settings-separator">|</span>
        <span>{count}</span>
      </>}
      <Icon className={`generation-settings-chevron ${open ? 'open' : ''}`} name="chevron-down" />
    </button>

    {open && <section className="generation-settings-popover" id={panelId} style={popoverStyle} aria-label={t('生成设置选项')}>
      {matrix ? <>
        <SettingGroup label={t('选择比例')}>
          <div className="generation-setting-options size-options">
            {matrix.ratios.map((ratio) => <ChoiceButton key={ratio} active={ratio === active!.ratio} onClick={() => selectRatio(ratio)}>{ratio}</ChoiceButton>)}
          </div>
        </SettingGroup>
        <SettingGroup label={t('选择分辨率')}>
          <div className="generation-setting-options size-options">
            {matrix.tiers.map((tier) => <ChoiceButton key={tier} active={tier === active!.tier} onClick={() => selectTier(tier)}>{tier}</ChoiceButton>)}
          </div>
        </SettingGroup>
      </> : <SettingGroup label={video ? t('选择比例') : t('选择尺寸')}>
        <div className="generation-setting-options size-options">
          {sizes.map((item) => <ChoiceButton key={item} active={item === size} onClick={() => onSizeChange(item)}>{labelOf(item)}</ChoiceButton>)}
        </div>
      </SettingGroup>}

      {video && <SettingGroup label={t('选择时长')}>
        <div className="generation-setting-options quality-options">
          {durations.map((item) => <ChoiceButton key={item} active={item === duration} onClick={() => onDurationChange?.(item)}>{durationLabel(item)}</ChoiceButton>)}
        </div>
      </SettingGroup>}

      {(!video || qualities.length > 0) && <SettingGroup label={video ? t('选择分辨率') : t('选择质量')}>
        <div className="generation-setting-options quality-options">
          {qualities.map((item) => <ChoiceButton key={item} active={item === quality} onClick={() => onQualityChange(item)}>{labelOf(item)}</ChoiceButton>)}
        </div>
      </SettingGroup>}

      {!video && <SettingGroup label={t('生成数量')}>
        <div className="generation-setting-options count-options">
          {counts.map((item) => <ChoiceButton key={item} active={item === count} onClick={() => onCountChange(item)}>{item}</ChoiceButton>)}
        </div>
      </SettingGroup>}
    </section>}
  </div>;
}

function SettingGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="generation-setting-group">
    <p>{label}</p>
    {children}
  </div>;
}

function ChoiceButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className={`generation-setting-choice ${active ? 'active' : ''}`} type="button" aria-pressed={active} onClick={onClick}>{children}</button>;
}
