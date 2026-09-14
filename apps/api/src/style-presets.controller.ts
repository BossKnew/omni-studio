import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { diskStorage } from 'multer';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from './common';
import { MAX_IMAGE_BYTES } from './domain-constants';
import { mediaStagingDirName } from './process-role';
import { parseBody, safeText } from './validation';
import { StylePresetsService } from './style-presets.service';
import { StorageService } from './storage.service';
import { isStylePresetId, MAX_STYLE_PRESET_NAME, MAX_STYLE_PRESET_SUFFIX } from './style-presets';
import { UploadAdmissionInterceptor } from './upload-admission.interceptor';
import { applyPrivateCatalogCache, catalogEtag } from './cache-policy';

const stylePresetIdSchema = z.string().refine(isStylePresetId, '风格预设 ID 无效');
const createSchema = z.object({
  id: stylePresetIdSchema.optional(),
  nameZh: safeText(MAX_STYLE_PRESET_NAME),
  nameEn: safeText(MAX_STYLE_PRESET_NAME),
  suffix: safeText(MAX_STYLE_PRESET_SUFFIX),
}).strict();
const updateSchema = z.object({
  nameZh: safeText(MAX_STYLE_PRESET_NAME).optional(),
  nameEn: safeText(MAX_STYLE_PRESET_NAME).optional(),
  suffix: safeText(MAX_STYLE_PRESET_SUFFIX).optional(),
}).strict();
const moveSchema = z.object({ direction: z.enum(['up', 'down']) }).strict();

const previewUpload = {
  limits: { fileSize: MAX_IMAGE_BYTES },
  storage: diskStorage({
    destination: (_request, _file, callback) => {
      const directory = resolve(process.env.MEDIA_ROOT ?? resolve(process.cwd(), 'media'), mediaStagingDirName());
      mkdirSync(directory, { recursive: true });
      callback(null, directory);
    },
    filename: (_request, _file, callback) => callback(null, `${randomUUID()}.upload`),
  }),
};

function parseId(id: string) {
  if (!isStylePresetId(id)) throw new BadRequestException('风格预设 ID 无效');
  return id;
}

@Controller()
export class StylePresetsController {
  constructor(private presets: StylePresetsService, private storage: StorageService) {}

  @Get('style-presets')
  async list(@Req() request?: Request, @Res({ passthrough: true }) response?: Response) {
    const payload = await this.presets.listPublic();
    if (applyPrivateCatalogCache(request, response, catalogEtag(payload))) return;
    return payload;
  }

  @Get('style-presets/:id/preview')
  async preview(@Param('id') id: string, @Res() response: Response) {
    const file = await this.presets.previewFile(parseId(id));
    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Cache-Control', 'private, max-age=3600');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Length', String(file.sizeBytes));
    if (process.env.MEDIA_X_ACCEL_REDIRECT === 'true') {
      const safeObjectKey = file.objectKey.split('/').map(encodeURIComponent).join('/');
      response.setHeader('X-Accel-Redirect', `/_protected_media/${safeObjectKey}`);
      response.end();
      return;
    }
    const stream = this.storage.createReadStream(file.objectKey);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  }

  @Roles('ADMIN')
  @Get('admin/style-presets')
  adminList() {
    return this.presets.listAdmin();
  }

  @Roles('ADMIN')
  @Post('admin/style-presets')
  create(@CurrentUser() actor: AuthUser, @Body() raw: unknown) {
    return this.presets.create(actor.id, parseBody(createSchema, raw));
  }

  @Roles('ADMIN')
  @Patch('admin/style-presets/:id')
  update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() raw: unknown) {
    return this.presets.update(actor.id, parseId(id), parseBody(updateSchema, raw));
  }

  @Roles('ADMIN')
  @Delete('admin/style-presets/:id')
  remove(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.presets.remove(actor.id, parseId(id));
  }

  @Roles('ADMIN')
  @Post('admin/style-presets/:id/move')
  move(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() raw: unknown) {
    const body = parseBody(moveSchema, raw);
    return this.presets.move(actor.id, parseId(id), body.direction);
  }

  @Roles('ADMIN')
  @Post('admin/style-presets/:id/preview')
  @UseInterceptors(UploadAdmissionInterceptor, FileInterceptor('file', previewUpload))
  async uploadPreview(@CurrentUser() actor: AuthUser, @Param('id') id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('请选择图片');
    try {
      return await this.presets.savePreview(actor.id, parseId(id), file.path, file.mimetype);
    } catch (error) {
      await this.storage.deleteStaged(file.path).catch(() => undefined);
      throw error instanceof BadRequestException || error instanceof NotFoundException ? error : new BadRequestException((error as Error).message);
    }
  }
}
