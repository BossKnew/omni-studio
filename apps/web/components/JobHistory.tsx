import { memo, useState } from 'react';
import type { Asset, ConversationDetail, GenerationJob } from '@/lib/studio-types';
import type { DownloadResult } from '@/lib/download';
import { useI18n } from '@/lib/i18n';
import Icon from '@/components/Icon';

type JobHistoryProps = {
  conversation: ConversationDetail;
  onLoadOlder: () => Promise<void>;
  referenceIds: string[];
  onDeleteConversation: () => void;
  onUseAsReference: (asset: Asset, prompt?: string) => void;
  onOpenImage: (asset: Asset) => void;
  onRetry: (jobId: string) => Promise<void>;
  onReuse: (jobId: string) => Promise<void>;
  onDownloadConversation: (conversationId: string) => Promise<DownloadResult>;
};

function JobHistory({ conversation, onLoadOlder, referenceIds, onDeleteConversation, onUseAsReference, onOpenImage, onRetry, onReuse, onDownloadConversation }: JobHistoryProps) {
  const { t } = useI18n();
  const [retryingJobId, setRetryingJobId] = useState('');
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});
  const [reusingJobId, setReusingJobId] = useState('');
  const [reuseErrors, setReuseErrors] = useState<Record<string, string>>({});
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState('');

  async function retry(jobId: string) {
    setRetryingJobId(jobId);
    setRetryErrors((items) => ({ ...items, [jobId]: '' }));
    try {
      await onRetry(jobId);
    } catch (caught) {
      setRetryErrors((items) => ({ ...items, [jobId]: (caught as Error).message }));
    } finally {
      setRetryingJobId('');
    }
  }

  async function reuse(jobId: string) {
    setReusingJobId(jobId);
    setReuseErrors((items) => ({ ...items, [jobId]: '' }));
    try {
      await onReuse(jobId);
    } catch (caught) {
      setReuseErrors((items) => ({ ...items, [jobId]: (caught as Error).message }));
    } finally {
      setReusingJobId('');
    }
  }

  async function downloadConversation() {
    setDownloadBusy(true);
    setDownloadMessage('');
    try {
      const result = await onDownloadConversation(conversation.id);
      setDownloadMessage(result.failed.length ? t('已完成部分下载') + '：' + result.completed + '；' + t('失败') + '：' + result.failed.length : t('下载已开始'));
    } catch (caught) {
      setDownloadMessage((caught as Error).message);
    } finally {
      setDownloadBusy(false);
    }
  }

  return <section className="jobs stack">
    <div className="jobs-heading">
      <h2>{conversation.title}</h2>
      <div className="job-toolbar">
        <button className="button" type="button" disabled={downloadBusy} onClick={() => void downloadConversation()}>{downloadBusy ? t('下载中…') : t('下载本会话素材')}</button>
        <button className="button danger" type="button" onClick={onDeleteConversation}>{t('删除会话')}</button>
      </div>
    </div>
    {downloadMessage && <p className={downloadMessage.includes(t('失败')) ? 'error' : 'success'}>{downloadMessage}</p>}
    {conversation.nextJobCursor && <button className="button" type="button" onClick={() => void onLoadOlder()}>{t('加载更早记录')}</button>}
    {conversation.jobs.map((job) => <article className="card stack job-card" key={job.id}>
      <div className="job-heading">
        <div className="row"><strong>{job.modelSnapshot.displayName}</strong><span>{modeLabel(job.mode, t)}</span><span className="muted">{job.status}</span></div>
        <div className="job-actions">
          <button className="button" type="button" disabled={reusingJobId === job.id} onClick={() => void reuse(job.id)}>{reusingJobId === job.id ? t('正在恢复…') : t('再次生成')}</button>
          {job.status === 'FAILED' && <button className="button" type="button" disabled={retryingJobId === job.id} onClick={() => void retry(job.id)}>{retryingJobId === job.id ? t('正在重试…') : t('重试')}</button>}
        </div>
      </div>
      <p>{job.prompt}</p>
      {job.errorMessage && <p className="error">{t(job.errorMessage)}</p>}
      {retryErrors[job.id] && <p className="error">{retryErrors[job.id]}</p>}
      {reuseErrors[job.id] && <p className="error">{reuseErrors[job.id]}</p>}
      <div className="job-images">{job.assets.map((jobAsset) => {
        if (jobAsset.deleted || !jobAsset.contentUrl) return <DeletedAssetPlaceholder key={jobAsset.id} />;
        const referenceAsset: Asset = { ...jobAsset, contentUrl: jobAsset.contentUrl, role: 'OUTPUT', note: jobAsset.note ?? null, generationPrompt: job.prompt };
        const selected = referenceIds.includes(jobAsset.id);
        return <div className={'image-card job-image-card ' + (selected ? 'selected-reference' : '')} key={jobAsset.id}>
          <button className="image-thumbnail" type="button" onClick={() => onOpenImage(referenceAsset)} aria-label={jobAsset.mediaKind === 'VIDEO' ? t('播放生成视频') : t('放大查看生成图片')}>
            {jobAsset.thumbnailUrl
              ? <img src={jobAsset.thumbnailUrl} width={jobAsset.thumbnailWidth ?? undefined} height={jobAsset.thumbnailHeight ?? undefined} loading="lazy" decoding="async" alt={job.prompt} />
              : <span className="image-preview-missing">{t('暂无预览')}</span>}
            {jobAsset.mediaKind === 'VIDEO' && <Icon className="video-play-badge" name="play" />}
            <span className="image-expand" aria-hidden="true">{jobAsset.mediaKind === 'VIDEO' ? t('播放') : t('放大')}</span>
          </button>
          {jobAsset.mediaKind === 'VIDEO' ? null : <button className="button reference-button" type="button" onClick={() => onUseAsReference(referenceAsset, job.prompt)}>{selected ? t('已选为参考图') : t('设为参考图')}</button>}
        </div>;
      })}{Array.from({ length: legacyDeletedAssetCount(job) }, (_, index) => <DeletedAssetPlaceholder key={'legacy-deleted-' + index} />)}</div>
    </article>)}
  </section>;
}

function modeLabel(mode: string, t: (key: string) => string) {
  if (mode === 'IMAGE_EDIT') return t('整图编辑');
  if (mode === 'INPAINT') return t('局部重绘');
  if (mode === 'TEXT_TO_VIDEO') return t('文生视频');
  if (mode === 'IMAGE_TO_VIDEO') return t('图生视频');
  if (mode === 'FIRST_LAST_FRAME_TO_VIDEO') return t('首尾帧');
  return t('文生图');
}

function legacyDeletedAssetCount(job: GenerationJob) {
  if (job.status !== 'SUCCEEDED') return 0;
  const requestedCount = Math.max(1, Number(job.parameters.count) || 1);
  return Math.max(0, requestedCount - job.assets.length);
}

function DeletedAssetPlaceholder() {
  const { t } = useI18n();
  return <div className="deleted-asset-placeholder" role="status"><Icon name="image" /><strong>{t('已在资产库中删除')}</strong></div>;
}

export default memo(JobHistory);
