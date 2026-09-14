import { Body, ConflictException, Controller, Delete, Get, HttpException, HttpStatus, Logger, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CurrentUser, Roles, safeErrorMessage, type AuthUser } from './common';
import { CryptoService } from './crypto.service';
import { PrismaService } from './prisma.service';
import { SafeHttpService } from './safe-http.service';
import { parseBody, safeText } from './validation';
import { z } from 'zod';
import { normalizeProviderHeaders } from './provider-headers';
import { providerRequestHeaders } from './provider-credentials';
import { ACTIVE_JOB_STATUSES, IMAGE_ADAPTER_KIND, isVideoAdapterKind } from './domain-constants';
import { createVideoAdapter, testModelsList } from './video-adapters';
import { normalizeAdapterKind } from './provider-adapter';
import { testQwenImageConnection } from './qwen-image';
import { testBananaConnection } from './nano-banana';
import { testSeedreamConnection } from './seedream';
import { testFluxConnection } from './flux';
import { testMidjourneyConnection } from './midjourney';
import { testRunwayImageConnection } from './runway-image';

const headersSchema = z.record(z.string().max(128), z.string().max(4096));
const providerCreateSchema = z.object({
  name: safeText(64), baseUrl: z.string().max(2048), apiKey: z.string().min(1).max(16_384), headers: headersSchema.optional(),
  timeoutSeconds: z.number().int().min(10).max(3600).optional(),
  pollTimeoutSeconds: z.number().int().min(10).max(3600).optional(), enabled: z.boolean().optional(),
}).strict();
const providerUpdateSchema = providerCreateSchema.partial().strict();

function providerTestError(status: number) {
  if (status === 401 || status === 403) return '供应商认证失败，请检查 API Key、令牌分组及访问权限';
  if (status === 404) return '模型列表接口不存在，请检查 Base URL 是否包含正确的 /v1';
  if (status === 429) return '供应商限流或账户额度不足';
  if (status >= 500) return '供应商服务暂时不可用';
  return '模型列表接口测试失败';
}

@Roles('ADMIN')
@Controller('admin/providers')
export class ProvidersController {
  private readonly logger = new Logger(ProvidersController.name);
  constructor(
    private prisma: PrismaService,
    private crypto: CryptoService,
    private http: SafeHttpService,
  ) {}

  @Get()
  async list() {
    const rows = await this.prisma.provider.findMany({ where: { archivedAt: null }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { models: true } } } });
    return rows.map(({ encryptedApiKey, encryptedHeaders, ...row }) => ({ ...row, apiKeyMasked: encryptedApiKey ? '••••••••' : '', hasCustomHeaders: Boolean(encryptedHeaders) }));
  }

  @Post()
  async create(@CurrentUser() actor: AuthUser, @Body() raw: unknown) {
    const body = parseBody(providerCreateSchema, raw);
    const provider = await this.prisma.provider.create({ data: {
      name: body.name, baseUrl: this.http.validateBaseUrl(body.baseUrl), encryptedApiKey: this.crypto.encrypt(body.apiKey),
      encryptedHeaders: body.headers ? this.crypto.encrypt(JSON.stringify(normalizeProviderHeaders(body.headers))) : null,
      timeoutSeconds: body.timeoutSeconds ?? 180,
      pollTimeoutSeconds: body.pollTimeoutSeconds ?? 900,
      enabled: body.enabled !== false,
    }});
    await this.audit(actor.id, 'provider.created', provider.id);
    return { id: provider.id };
  }

  @Patch(':id')
  async update(@CurrentUser() actor: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() raw: unknown) {
    const body = parseBody(providerUpdateSchema, raw);
    await this.prisma.provider.update({ where: { id }, data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.baseUrl !== undefined ? { baseUrl: this.http.validateBaseUrl(body.baseUrl) } : {}),
      ...(body.apiKey ? { encryptedApiKey: this.crypto.encrypt(body.apiKey) } : {}),
      ...(body.headers !== undefined ? { encryptedHeaders: body.headers ? this.crypto.encrypt(JSON.stringify(normalizeProviderHeaders(body.headers))) : null } : {}),
      ...(body.timeoutSeconds !== undefined ? { timeoutSeconds: body.timeoutSeconds } : {}),
      ...(body.pollTimeoutSeconds !== undefined ? { pollTimeoutSeconds: body.pollTimeoutSeconds } : {}),
      ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
    }});
    await this.audit(actor.id, 'provider.updated', id);
    return { ok: true };
  }

  @Post(':id/test')
  async test(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() actor?: AuthUser) {
    const now = new Date();
    const cooldownUntil = new Date(now.getTime() + 120_000);
    const claimed = await this.prisma.provider.updateMany({
      where: { id, archivedAt: null, OR: [{ testCooldownUntil: null }, { testCooldownUntil: { lte: now } }] },
      data: { testCooldownUntil: cooldownUntil, lastTestOk: null },
    });
    if (!claimed.count) {
      const current = await this.prisma.provider.findUniqueOrThrow({ where: { id }, select: { testCooldownUntil: true } });
      const retryAfterSeconds = Math.max(1, Math.ceil(((current.testCooldownUntil?.getTime() ?? now.getTime()) - now.getTime()) / 1000));
      throw new HttpException({ message: `请等待 ${retryAfterSeconds} 秒后再次测试`, retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const provider = await this.prisma.provider.findUniqueOrThrow({ where: { id } });
    const headers = providerRequestHeaders(this.crypto, provider);
    const models = await this.prisma.model.findMany({ where: { providerId: id }, select: { adapterKind: true } });
    const adapterKinds = [...new Set(models.map((model) => normalizeAdapterKind(model.adapterKind)))];
    const toProbe = adapterKinds.length ? adapterKinds : [IMAGE_ADAPTER_KIND];
    try {
      let probed: { ok: boolean; status?: number; message?: string } = { ok: false };
      for (const adapterKind of toProbe) {
        probed = await this.probeAdapter(adapterKind, provider, headers);
        if (!probed.ok) {
          const error = probed.message ?? (probed.status ? providerTestError(probed.status) : '供应商连接失败');
          this.logger.warn(`供应商 ${id} 测试失败：HTTP ${probed.status ?? 'n/a'} adapter=${adapterKind}`);
          await this.prisma.provider.update({ where: { id }, data: { lastTestOk: false } });
          if (actor) await this.audit(actor.id, 'provider.tested', id);
          return { ok: false, status: probed.status, error, cooldownUntil };
        }
      }
      await this.prisma.provider.update({ where: { id }, data: { lastTestOk: true } });
      if (actor) await this.audit(actor.id, 'provider.tested', id);
      return {
        ok: true, status: probed.status, cooldownUntil,
        ...(adapterKinds.length ? {} : { note: '添加模型后会按适配器类型做更准确的测试' }),
      };
    } catch (error) {
      const result = { ok: false, error: '供应商连接失败', cooldownUntil };
      this.logger.warn(`供应商 ${id} 连接测试失败：${safeErrorMessage(error)}`);
      await this.prisma.provider.update({ where: { id }, data: { lastTestOk: false } });
      if (actor) await this.audit(actor.id, 'provider.tested', id);
      return result;
    }
  }

  private probeAdapter(adapterKind: string, provider: { baseUrl: string; timeoutSeconds: number; pollTimeoutSeconds: number }, headers: Record<string, string>) {
    const kind = normalizeAdapterKind(adapterKind);
    if (isVideoAdapterKind(kind) && kind !== 'openai-videos') {
      return createVideoAdapter(kind, {
        http: this.http,
        headers,
        baseUrl: provider.baseUrl,
        timeoutSeconds: provider.timeoutSeconds,
        pollTimeoutSeconds: provider.pollTimeoutSeconds,
      }).testConnection();
    }
    if (kind === 'qwen-image') {
      return testQwenImageConnection({ http: this.http, headers, baseUrl: provider.baseUrl, timeoutSeconds: provider.timeoutSeconds });
    }
    if (kind === 'nano-banana') {
      return testBananaConnection({ http: this.http, headers, baseUrl: provider.baseUrl, timeoutSeconds: provider.timeoutSeconds });
    }
    if (kind === 'seedream') {
      return testSeedreamConnection({ http: this.http, headers, baseUrl: provider.baseUrl, timeoutSeconds: provider.timeoutSeconds });
    }
    if (kind === 'flux') {
      return testFluxConnection({ http: this.http, headers, baseUrl: provider.baseUrl, timeoutSeconds: provider.timeoutSeconds });
    }
    if (kind === 'midjourney') {
      return testMidjourneyConnection({ http: this.http, headers, baseUrl: provider.baseUrl, timeoutSeconds: provider.timeoutSeconds });
    }
    if (kind === 'runway-images') {
      return testRunwayImageConnection({ http: this.http, headers, baseUrl: provider.baseUrl, timeoutSeconds: provider.timeoutSeconds });
    }
    return testModelsList({ http: this.http, headers, baseUrl: provider.baseUrl, timeoutSeconds: provider.timeoutSeconds });
  }

  @Delete(':id')
  async remove(@CurrentUser() actor: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.prisma.$transaction(async (transaction) => {
      const activeJobs = await transaction.generationJob.count({ where: { model: { providerId: id }, status: { in: [...ACTIVE_JOB_STATUSES] } } });
      if (activeJobs) throw new ConflictException('该供应商仍有正在排队或运行的任务，请等待任务完成后再删除');
      await transaction.model.deleteMany({ where: { providerId: id } });
      await transaction.provider.delete({ where: { id } });
      await transaction.auditLog.create({ data: { actorId: actor.id, action: 'provider.deleted', targetType: 'provider', targetId: id } });
      return { ok: true };
    });
  }

  private audit(actorId: string, action: string, targetId: string) {
    return this.prisma.auditLog.create({ data: { actorId, action, targetType: 'provider', targetId } });
  }
}
