CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Asset_note_trgm_idx" ON "Asset" USING GIN (note gin_trgm_ops);
CREATE INDEX "GenerationJob_prompt_trgm_idx" ON "GenerationJob" USING GIN (prompt gin_trgm_ops);
CREATE INDEX "GenerationJob_sourceAssetIds_gin_idx" ON "GenerationJob" USING GIN ((parameters -> 'sourceAssetIds'));

CREATE INDEX "Asset_library_live_created_idx"
  ON "Asset" ("userId", "createdAt" DESC, "id" DESC)
  WHERE "deletedAt" IS NULL AND "role" IN ('UPLOAD', 'OUTPUT');

CREATE INDEX "Asset_library_live_kind_created_idx"
  ON "Asset" ("userId", "mediaKind", "createdAt" DESC, "id" DESC)
  WHERE "deletedAt" IS NULL AND "role" IN ('UPLOAD', 'OUTPUT');

CREATE INDEX "Asset_library_trash_deleted_idx"
  ON "Asset" ("userId", "deletedAt" DESC, "id" DESC)
  WHERE "deletedAt" IS NOT NULL AND "purgedAt" IS NULL AND "role" IN ('UPLOAD', 'OUTPUT');

ALTER TABLE "PromptEntry" ADD COLUMN "promptHash" TEXT;
UPDATE "PromptEntry" SET "promptHash" = encode(sha256(convert_to("prompt", 'UTF8')), 'hex') WHERE "promptHash" IS NULL;
ALTER TABLE "PromptEntry" ALTER COLUMN "promptHash" SET NOT NULL;
DROP INDEX "PromptEntry_userId_prompt_key";
CREATE UNIQUE INDEX "PromptEntry_userId_promptHash_key" ON "PromptEntry"("userId", "promptHash");
