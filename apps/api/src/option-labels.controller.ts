import { BadRequestException, Body, Controller, Get, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser, Roles, type AuthUser } from './common';
import { PrismaService } from './prisma.service';
import { parseBody } from './validation';
import { z } from 'zod';
import { OPTION_LABELS_KEY, optionLabelItemsFromMap, optionLabelMapFromItems, parseOptionLabelMap } from './option-labels';
import { applyPrivateCatalogCache, catalogEtag } from './cache-policy';

const itemSchema = z.object({
  value: z.string().min(1).max(64),
  zh: z.string().max(32).optional().nullable(),
  en: z.string().max(32).optional().nullable(),
}).strict();
const saveSchema = z.object({ items: z.array(itemSchema).max(100) }).strict();

@Controller()
export class OptionLabelsController {
  constructor(private prisma: PrismaService) {}

  @Get('option-labels')
  async publicLabels(@Req() request?: Request, @Res({ passthrough: true }) response?: Response) {
    const map = await this.readMap();
    if (applyPrivateCatalogCache(request, response, catalogEtag(map))) return;
    return map;
  }

  @Roles('ADMIN')
  @Get('admin/option-labels')
  async adminLabels() {
    return { items: optionLabelItemsFromMap(await this.readMap()) };
  }

  @Roles('ADMIN')
  @Put('admin/option-labels')
  async save(@CurrentUser() actor: AuthUser, @Body() raw: unknown) {
    const body = parseBody(saveSchema, raw);
    let map;
    try { map = optionLabelMapFromItems(body.items); }
    catch (error) { throw new BadRequestException((error as Error).message); }
    await this.prisma.$transaction([
      this.prisma.systemSetting.upsert({
        where: { key: OPTION_LABELS_KEY },
        create: { key: OPTION_LABELS_KEY, value: map },
        update: { value: map },
      }),
      this.prisma.auditLog.create({ data: { actorId: actor.id, action: 'option-labels.updated', targetType: 'setting', targetId: OPTION_LABELS_KEY, metadata: { count: Object.keys(map).length } } }),
    ]);
    return { items: optionLabelItemsFromMap(map) };
  }

  private async readMap() {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: OPTION_LABELS_KEY }, select: { value: true } });
    try { return parseOptionLabelMap(row?.value); }
    catch { return {}; }
  }
}
