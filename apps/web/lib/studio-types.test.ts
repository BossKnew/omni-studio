import assert from 'node:assert/strict';
import test from 'node:test';
import { assignFrameRoles, getActiveGenerationJobs, isVideoGenerationMode, type ConversationDetail, type GenerationStatus, type ReferenceSelection } from './studio-types.ts';

function job(id: string, status: GenerationStatus): ConversationDetail['jobs'][number] {
  return {
    id,
    status,
    mode: 'TEXT_TO_IMAGE',
    mediaKind: 'IMAGE',
    prompt: '',
    errorMessage: null,
    parameters: {},
    modelSnapshot: { displayName: 'Test' },
    assets: [],
  };
}

test('selects queued and running jobs for watcher recovery', () => {
  const conversation: ConversationDetail = {
    id: 'conversation-1',
    title: 'Test',
    jobs: [
      job('queued', 'QUEUED'),
      job('running', 'RUNNING'),
      job('succeeded', 'SUCCEEDED'),
      job('failed', 'FAILED'),
      job('cancelled', 'CANCELLED'),
    ],
  };

  assert.deepEqual(getActiveGenerationJobs(conversation).map(({ id }) => id), ['queued', 'running']);
});

test('treats first-last-frame jobs as video generation', () => {
  assert.equal(isVideoGenerationMode('FIRST_LAST_FRAME_TO_VIDEO'), true);
  assert.equal(isVideoGenerationMode('IMAGE_TO_VIDEO'), true);
  assert.equal(isVideoGenerationMode('TEXT_TO_IMAGE'), false);
});

test('assigns untagged references to first then last frame slots', () => {
  const first: ReferenceSelection = { key: 'a', kind: 'file', file: new File(['a'], 'a.png', { type: 'image/png' }) };
  const last: ReferenceSelection = { key: 'b', kind: 'file', file: new File(['b'], 'b.png', { type: 'image/png' }) };
  const extra: ReferenceSelection = { key: 'c', kind: 'file', file: new File(['c'], 'c.png', { type: 'image/png' }) };
  assert.deepEqual(assignFrameRoles([first, last, extra]).map((item) => [item.key, item.frameRole]), [['a', 'first'], ['b', 'last']]);
});

test('fills an empty last-frame slot from a later untagged reference', () => {
  const first: ReferenceSelection = { key: 'a', kind: 'file', file: new File(['a'], 'a.png', { type: 'image/png' }), frameRole: 'first' };
  const last: ReferenceSelection = { key: 'b', kind: 'file', file: new File(['b'], 'b.png', { type: 'image/png' }) };
  assert.deepEqual(assignFrameRoles([first, last]).map((item) => [item.key, item.frameRole]), [['a', 'first'], ['b', 'last']]);
});
