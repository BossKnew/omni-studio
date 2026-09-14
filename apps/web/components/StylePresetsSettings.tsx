import { FormEvent, useEffect, useState } from 'react';
import { api, json } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { NONE_STYLE_PRESET_PREVIEW, type AdminStylePreset } from '@/lib/style-presets';

type StylePresetsSettingsProps = {
  onNotice: (kind: 'success' | 'error', message: string) => void;
  onError: (message: string) => void;
};

type PresetForm = {
  nameZh: string;
  nameEn: string;
  suffix: string;
  previewFile: File | null;
};

const emptyForm = (): PresetForm => ({ nameZh: '', nameEn: '', suffix: '', previewFile: null });

export default function StylePresetsSettings({ onNotice, onError }: StylePresetsSettingsProps) {
  const { t } = useI18n();
  const [items, setItems] = useState<AdminStylePreset[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PresetForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);

  async function load() {
    try {
      const result = await api<{ items: AdminStylePreset[] }>('/admin/style-presets');
      setItems(result.items);
      onError('');
    } catch (caught) {
      onError((caught as Error).message);
    }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!form.previewFile) {
      setPreviewObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(form.previewFile);
    setPreviewObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [form.previewFile]);

  function update<K extends keyof PresetForm>(key: K, value: PresetForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function beginEdit(item: AdminStylePreset) {
    setEditingId(item.id);
    setForm({ nameZh: item.nameZh, nameEn: item.nameEn, suffix: item.suffix, previewFile: null });
    setFileInputKey((current) => current + 1);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm());
    setFileInputKey((current) => current + 1);
  }

  async function uploadPreview(id: string, file: File) {
    const body = new FormData();
    body.append('file', file);
    return api<AdminStylePreset>(`/admin/style-presets/${id}/preview`, { method: 'POST', body });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    onError('');
    const wasEditing = editingId !== null;
    try {
      const payload = { nameZh: form.nameZh.trim(), nameEn: form.nameEn.trim(), suffix: form.suffix.trim() };
      const saved = await (wasEditing
        ? api<AdminStylePreset>(`/admin/style-presets/${editingId}`, json('PATCH', payload))
        : api<AdminStylePreset>('/admin/style-presets', json('POST', payload)));
      if (form.previewFile) await uploadPreview(saved.id, form.previewFile);
      await load();
      cancelEdit();
      onNotice('success', wasEditing ? t('风格预设已保存') : t('风格预设已创建'));
    } catch (caught) {
      const message = (caught as Error).message;
      onError(message);
      onNotice('error', `${t('保存失败：')}${message}`);
    } finally {
      setSaving(false);
    }
  }

  async function move(item: AdminStylePreset, direction: 'up' | 'down') {
    try {
      await api(`/admin/style-presets/${item.id}/move`, json('POST', { direction }));
      await load();
    } catch (caught) {
      const message = (caught as Error).message;
      onError(message);
      onNotice('error', `${t('保存失败：')}${message}`);
    }
  }

  async function remove(item: AdminStylePreset) {
    if (!confirm(t('确定删除这个风格预设？'))) return;
    try {
      await api(`/admin/style-presets/${item.id}`, json('DELETE'));
      if (editingId === item.id) cancelEdit();
      await load();
      onNotice('success', t('风格预设已删除'));
    } catch (caught) {
      const message = (caught as Error).message;
      onError(message);
      onNotice('error', `${t('保存失败：')}${message}`);
    }
  }

  const editing = items.find((item) => item.id === editingId);
  const previewSrc = previewObjectUrl ?? editing?.previewUrl ?? NONE_STYLE_PRESET_PREVIEW;

  return <section className="admin-section admin-two-column">
    <section className={`card stack admin-panel ${editingId ? 'editing-panel' : ''}`}>
      <h2>{editingId ? t('编辑风格预设') : t('新建风格预设')}</h2>
      <form className="stack" onSubmit={save}>
        <label>{t('中文名称')}<input className="field" required maxLength={32} placeholder={t('例如 电影感')} value={form.nameZh} onChange={(event) => update('nameZh', event.target.value)} /></label>
        <label>{t('英文名称')}<input className="field" required maxLength={32} placeholder={t('例如 Cinematic')} value={form.nameEn} onChange={(event) => update('nameEn', event.target.value)} /></label>
        <label>{t('风格提示词')}<textarea className="field style-preset-suffix" required maxLength={2000} value={form.suffix} onChange={(event) => update('suffix', event.target.value)} /></label>
        <p className="muted">{t('发给模型的风格描述，会附加在用户提示词后面。')}</p>
        <label>{t('样张')}
          <input key={fileInputKey} className="field" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => update('previewFile', event.target.files?.[0] ?? null)} />
        </label>
        <img className="style-preset-admin-preview" src={previewSrc} alt={t('样张')} onError={(event) => { event.currentTarget.src = NONE_STYLE_PRESET_PREVIEW; }} />
        <div className="form-actions">
          {editingId && <button className="button" type="button" onClick={cancelEdit}>{t('取消')}</button>}
          <button className="button primary" disabled={saving}>{saving ? t('保存中…') : editingId ? t('保存修改') : t('创建预设')}</button>
        </div>
      </form>
    </section>
    <section className="card stack admin-panel">
      <h2>{t('已有风格预设')}</h2>
      <p className="muted">{t('管理工作台中的风格预设样张和提示词。')}</p>
      {items.length === 0 && <p className="muted">{t('还没有风格预设。')}</p>}
      {items.map((item, index) => <div className="admin-list-item style-preset-admin-item" key={item.id}>
        <img className="style-preset-admin-thumb" src={item.previewUrl} alt="" onError={(event) => { event.currentTarget.src = NONE_STYLE_PRESET_PREVIEW; }} />
        <div>
          <strong>{item.nameZh} / {item.nameEn}</strong>
          <p className="muted">{item.suffix}</p>
        </div>
        <div className="admin-actions">
          <button className="button" type="button" disabled={index === 0} onClick={() => void move(item, 'up')}>{t('上移')}</button>
          <button className="button" type="button" disabled={index === items.length - 1} onClick={() => void move(item, 'down')}>{t('下移')}</button>
          <button className="button" type="button" onClick={() => beginEdit(item)}>{t('编辑')}</button>
          <button className="button danger" type="button" onClick={() => void remove(item)}>{t('删除')}</button>
        </div>
      </div>)}
    </section>
  </section>;
}
