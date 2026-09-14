import { NONE_STYLE_PRESET_PREVIEW, stylePresetLabel, type StylePreset } from '@/lib/style-presets';
import { useI18n } from '@/lib/i18n';

type StylePresetPickerProps = {
  value: string;
  onChange: (id: string) => void;
  items: StylePreset[];
};

export default function StylePresetPicker({ value, onChange, items }: StylePresetPickerProps) {
  const { t, locale } = useI18n();

  return <div className="style-preset-picker">
    <p className="style-preset-picker-label">{t('风格预设')}</p>
    <div className="style-preset-scroller" role="listbox" aria-label={t('风格预设')}>
      <button
        className={'style-preset-card' + (!value ? ' active' : '')}
        type="button"
        role="option"
        aria-selected={!value}
        onClick={() => onChange('')}
      >
        <img src={NONE_STYLE_PRESET_PREVIEW} alt={t('无风格')} />
        <span>{t('无风格')}</span>
      </button>
      {items.map((preset) => {
        const label = stylePresetLabel(preset, locale);
        const selected = value === preset.id;
        return <button
          className={'style-preset-card' + (selected ? ' active' : '')}
          type="button"
          role="option"
          aria-selected={selected}
          key={preset.id}
          onClick={() => onChange(preset.id)}
        >
          <img src={preset.previewUrl} alt={label} onError={(event) => { event.currentTarget.src = NONE_STYLE_PRESET_PREVIEW; }} />
          <span>{label}</span>
        </button>;
      })}
    </div>
  </div>;
}
