import { Prisma } from './generated/prisma/client';

type RawClient = { $queryRaw: <T = unknown>(query: Prisma.Sql) => Promise<T> };

export async function findSourceIdsUsedInOtherConversations(
  db: RawClient,
  userId: string,
  conversationId: string,
  sourceIds: string[],
) {
  if (!sourceIds.length) return new Set<string>();
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT elem AS id
    FROM "GenerationJob" AS j
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(j.parameters->'sourceAssetIds', '[]'::jsonb)) AS elem
    WHERE j."userId" = ${userId}
      AND j."conversationId" <> ${conversationId}
      AND j.parameters->'sourceAssetIds' ?| ARRAY[${Prisma.join(sourceIds)}]::text[]
      AND elem IN (${Prisma.join(sourceIds)})
  `);
  return new Set(rows.map((row) => row.id));
}
