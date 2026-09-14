import { KeyboardEvent, useState } from 'react';
import type { ConversationSummary, StudioUser, UsageSnapshot } from '@/lib/studio-types';
import { formatStorageBytes } from '@/lib/format-bytes';
import { useI18n } from '@/lib/i18n';
import Icon from '@/components/Icon';
import { APP_VERSION } from '@/lib/version';

type StudioSidebarProps = {
  user: StudioUser;
  assetCount: number;
  conversations: ConversationSummary[];
  activeConversationId: string;
  activeView: 'studio' | 'assets';
  onNewCreation: () => void;
  onShowAssets: () => void;
  onLoadConversation: (id: string) => Promise<void>;
  hasMoreConversations: boolean;
  onLoadMoreConversations: () => Promise<void>;
  onRenameConversation: (id: string, title: string) => Promise<void>;
  onDeleteConversation: (conversation: ConversationSummary) => void;
  onShowProfile: () => void;
  onNavigateToAccount: () => void;
  onLogout: () => Promise<void>;
  usage: UsageSnapshot | null;
};

export default function StudioSidebar({
  user, assetCount, conversations, activeConversationId, activeView, onNewCreation, onShowAssets,
  onLoadConversation, hasMoreConversations, onLoadMoreConversations, onRenameConversation, onDeleteConversation, onShowProfile, onNavigateToAccount, onLogout, usage,
}: StudioSidebarProps) {
  const { t } = useI18n();
  const [recentOpen, setRecentOpen] = useState(true);
  const [renamingId, setRenamingId] = useState('');
  const [renameTitle, setRenameTitle] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);

  function beginRename(item: ConversationSummary) {
    setRenamingId(item.id);
    setRenameTitle(item.title);
    setError('');
  }

  async function saveRename(id: string) {
    const title = renameTitle.trim();
    if (!title) return;
    setRenaming(true);
    setError('');
    try {
      await onRenameConversation(id, title);
      setRenamingId('');
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setRenaming(false);
    }
  }

  function handleRenameKey(event: KeyboardEvent<HTMLInputElement>, id: string) {
    if (event.key === 'Enter') void saveRename(id);
    if (event.key === 'Escape') setRenamingId('');
  }

  return <aside className="sidebar">
    <h2 className="brand">OmniStudio</h2>
    <nav className="sidebar-nav" aria-label={t('工作区导航')}>
      <button className="button primary conversation" onClick={onNewCreation}><Icon name="plus" />{t('新创作')}</button>
      <button className={`button nav-button ${activeView === 'assets' ? 'active' : ''}`} onClick={onShowAssets}>
        <span className="nav-button-label"><Icon name="image" />{t('资产库')}</span>
        <span className="nav-count">{assetCount}</span>
      </button>
      <button className="recent-toggle" onClick={() => setRecentOpen((open) => !open)} aria-expanded={recentOpen} aria-controls="recent-conversations">
        <span>{t('最近会话')}</span><Icon className={`chevron ${recentOpen ? 'open' : ''}`} name="chevron-right" />
      </button>
      {recentOpen && <div id="recent-conversations" className="conversation-list">
        {conversations.length === 0 && <p className="sidebar-empty">{t('还没有会话')}</p>}
        {conversations.map((item) => <div key={item.id} className={`conversation-row ${activeView === 'studio' && activeConversationId === item.id ? 'active' : ''}`}>
          {renamingId === item.id ? <div className="rename-box">
            <input className="field rename-input" value={renameTitle} maxLength={80} autoFocus onChange={(event) => setRenameTitle(event.target.value)} onKeyDown={(event) => handleRenameKey(event, item.id)} aria-label={t('会话名称')} />
            <button className="icon-button success-action" onClick={() => void saveRename(item.id)} disabled={renaming || !renameTitle.trim()} aria-label={t('保存重命名')}><Icon name="check" /></button>
            <button className="icon-button" onClick={() => setRenamingId('')} disabled={renaming} aria-label={t('取消重命名')}><Icon name="close" /></button>
          </div> : <>
            <button className="conversation-main" onClick={() => void onLoadConversation(item.id)} title={item.title}>
              <span className="conversation-title">{item.title}</span>
            </button>
            <div className="conversation-actions">
              <button className="icon-button" onClick={() => beginRename(item)} aria-label={`${t('重命名')} ${item.title}`} title={t('重命名')}><Icon name="edit" /></button>
              <button className="icon-button danger-action" onClick={() => onDeleteConversation(item)} aria-label={`${t('删除')} ${item.title}`} title={t('删除')}><Icon name="close" /></button>
            </div>
          </>}
        </div>)}
        {hasMoreConversations && <button className="button" type="button" onClick={() => void onLoadMoreConversations()}>{t('加载更多会话')}</button>}
      </div>}
      {error && <p className="error sidebar-error">{error}</p>}
    </nav>
    <div className="sidebar-end">
    {usage && <section className="usage-panel" aria-label={t('用量')}>
      <p className="usage-row"><span>{t('存储')}</span><strong>{formatStorageBytes(usage.storageBytes)} / {formatStorageBytes(usage.storageQuotaBytes)}</strong></p>
      {usage.policies.map((policy) => <p className={'usage-row ' + (policy.remaining === 0 ? 'usage-full' : '')} key={policy.groupId}>
        <span title={policy.groupName}>{policy.groupName}</span>
        <strong>{policy.used} / {policy.points} · {policy.window}</strong>
      </p>)}
          </section>}
    <div className="account-area">
      {accountOpen && <div className="account-popover" role="menu">
        <button className="account-menu-item" role="menuitem" onClick={() => { setAccountOpen(false); onShowProfile(); }}>{t('个人信息')}</button>
        <button className="account-menu-item" role="menuitem" onClick={onNavigateToAccount}>{user.role === 'ADMIN' ? t('管理后台') : t('设置')}</button>
        <button className="account-menu-item danger-text" role="menuitem" onClick={() => void onLogout()}>{t('退出登录')}</button>
      </div>}
      <button className="account-trigger" type="button" aria-haspopup="menu" aria-expanded={accountOpen} onClick={() => setAccountOpen((open) => !open)}>
        <span className="user-avatar" aria-hidden="true">{avatarText(user.displayName || user.username)}</span>
        <span className="account-copy"><strong>{user.displayName || user.username}</strong><span>{user.username}</span></span>
        <Icon className="account-chevron" name="chevron-up" />
      </button>
    </div>
    <p className="sidebar-version">OmniStudio v{APP_VERSION}</p>
    </div>
  </aside>;
}

function avatarText(name: string) {
  const value = name.trim();
  const chinese = value.match(/[\u3400-\u9fff]/);
  if (chinese) return chinese[0];
  const letters = value.replace(/[^A-Za-z0-9]/g, '');
  return (letters.slice(0, 2) || value.slice(0, 1) || '?').toUpperCase();
}
