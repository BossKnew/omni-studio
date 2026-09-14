import { Prisma } from './generated/prisma/client';
import { findSourceIdsUsedInOtherConversations } from './source-asset-refs';

describe('findSourceIdsUsedInOtherConversations', () => {
  it('skips the database when there are no candidate uploads', async () => {
    const db = { $queryRaw: jest.fn() };
    await expect(findSourceIdsUsedInOtherConversations(db, 'user-1', 'conversation-1', [])).resolves.toEqual(new Set());
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('asks Postgres for overlapping sourceAssetIds instead of N JSON contains predicates', async () => {
    const db = { $queryRaw: jest.fn().mockResolvedValue([{ id: 'shared-upload' }]) };
    await expect(findSourceIdsUsedInOtherConversations(db, 'user-1', 'conversation-1', ['exclusive-upload', 'shared-upload'])).resolves.toEqual(new Set(['shared-upload']));
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const query = db.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(query.strings.join(' ')).toContain('?|');
    expect(query.strings.join(' ')).toContain('jsonb_array_elements_text');
  });
});
