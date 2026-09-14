import { createHash } from 'node:crypto';

export function promptHash(prompt: string) {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}
