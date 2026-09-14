import { buildResolutionMatrix, type ResolutionTier } from '@/lib/resolution-options';
import { useI18n } from '@/lib/i18n';
import { FormEvent, useEffect, useState } from 'react';
import { api, json } from '@/lib/api';
type LabelRow = { id: string; value: string; zh: string; en: string };
type OptionLabelsSettingsProps = {
  onNotice: (kind: 'success' | 'error', message: string) => void;
  onError: (message: string) => void;
};

function newRow(partial: Partial<LabelRow> = {}): LabelRow {
  return { id: crypto.randomUUID(), value: '', zh: '', en: '', ...partial };
}

export default function OptionLabelsSettings({ onNotice, onError }: OptionLabelsSettingsProps) {
  const { t } = useI18n();
  const [rows, setRows] = useState<LabelRow[]>([newRow()]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ items: Array<{ value: string; zh: string; en: string }> }>('/admin/option-labels')
      .then((result) => setRows(result.items.length ? result.items.map((item) => newRow(item)) : [newRow()]))
      .catch((caught) => onError((caught as Error).message));
  }, [onError]);

  function updateRow(id: string, patch: Partial<LabelRow>) {
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  }

  async function suggestFromModels() {
    try {
      const models = await api<Array<{ allowedSizes: string[]; allowedQualities: string[]; resolutionTiers: ResolutionTier[]; allowedRatios: string[] }>>('/admin/models');
      const existing = new Set(rows.map((row) => row.value.trim()).filter(Boolean));
      const extras = [...new Set(models.flatMap((model) => {
        const sizes = model.allowedSizes.length ? model.allowedSizes : (buildResolutionMatrix(model.resolutionTiers, model.allowedRatios)?.entries.map((entry) => entry.size) ?? []);
        return [...sizes, ...model.allowedQualities];
      }))]
        .filter((value) => value && !existing.has(value))
        .sort((left, right) => left.localeCompare(right));
      if (!extras.length) {
        onNotice('success', t('没有新的尺寸或质量取值'));
        return;
      }
      setRows((current) => {
        const filled = current.filter((row) => row.value.trim() || row.zh.trim() || row.en.trim());
        return [...filled, ...extras.map((value) => newRow({ value }))];
      });
    } catch (caught) {
      onError((caught as Error).message);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const items = rows
      .map((row) => ({ value: row.value.trim(), zh: row.zh.trim(), en: row.en.trim() }))
      .filter((row) => row.value);
    setBusy(true);
    onError('');
    try {
      const result = await api<{ items: Array<{ value: string; zh: string; en: string }> }>('/admin/option-labels', json('PUT', { items }));
      setRows(result.items.length ? result.items.map((item) => newRow(item)) : [newRow()]);
      onNotice('success', t('显示文案已保存'));
    } catch (caught) {
      const message = (caught as Error).message;
      onError(message);
      onNotice('error', `${t('保存失败：')}${message}`);
    } finally {
      setBusy(false);
    }
  }

  return <section className="admin-section stack">
    <section className="card stack admin-panel">
      <h2>{t('尺寸与质量显示文案')}</h2>
      <p className="muted">{t('工作台按当前语言显示这里的文案。某一语言留空则显示模型里的原始取值，例如 auto、1024x1024。发给供应商的值不会改变。')}</p>
      <form className="stack" onSubmit={save}>
        <div className="table-scroll">
          <table>
            <thead><tr><th>{t('取值')}</th><th>{t('中文')}</th><th>{t('英文')}</th><th /></tr></thead>
            <tbody>
              {rows.map((row) => <tr key={row.id}>
                <td><input className="field" value={row.value} maxLength={64} placeholder="auto" onChange={(event) => updateRow(row.id, { value: event.target.value })} /></td>
                <td><input className="field" value={row.zh} maxLength={32} placeholder={t('例如 自动')} onChange={(event) => updateRow(row.id, { zh: event.target.value })} /></td>
                <td><input className="field" value={row.en} maxLength={32} placeholder="Auto" onChange={(event) => updateRow(row.id, { en: event.target.value })} /></td>
                <td><button className="button" type="button" onClick={() => setRows((current) => current.length === 1 ? [newRow()] : current.filter((item) => item.id !== row.id))}>{t('删除')}</button></td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <div className="form-actions">
          <button className="button" type="button" onClick={() => setRows((current) => [...current, newRow()])}>{t('添加一行')}</button>
          <button className="button" type="button" onClick={() => void suggestFromModels()}>{t('从模型补全取值')}</button>
          <button className="button primary" disabled={busy}>{busy ? t('保存中…') : t('保存')}</button>
        </div>
      </form>
    </section>
  </section>;
}
