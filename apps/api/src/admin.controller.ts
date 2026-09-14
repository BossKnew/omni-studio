import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { AuthService } from './auth.service';
import { assertPassword, CurrentUser, Roles, type AuthUser } from './common';
import { PrismaService } from './prisma.service';
import { StorageService } from './storage.service';
import { parseBody, passwordSchema, safeText, uuidSchema } from './validation';
import { parseQuotaPair } from './generation-quota';
import { z } from 'zod';
import { hashPassword } from './password-hash';
import { AuthContextService } from './auth-context.service';
import { GenerationLifecycleService } from './generation-lifecycle.service';
import { ACTIVE_JOB_STATUSES } from './domain-constants';
import { cursorWhere, decodeCursor, encodeCursor, pageLimit } from './pagination';
import { parseTrashRetention, trashRetentionFromSetting } from './trash-retention';
import { parseUploadMaxLongEdge, UPLOAD_IMAGE_SETTING_KEY, uploadImagePolicyFromSetting } from './upload-image-policy';

const registrationSchema = z.object({ enabled: z.boolean() }).strict();
const statusSchema = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) }).strict();
const resetSchema = z.object({ password: passwordSchema }).strict();
const resetMfaSchema = z.object({ actorCode: z.string().regex(/^\d{6}$/) }).strict();
const sessionDurationSchema = z.object({ duration: z.string().min(2).max(4) }).strict();
const trashRetentionSchema = z.object({ duration: z.string().min(2).max(4) }).strict();
const uploadImageSchema = z.object({ maxLongEdge: z.number() }).strict();
const userGroupSchema = z.object({
  name: safeText(64),
  description: safeText(300).optional().nullable(),
  quotaWindow: z.string().max(4).nullable().optional(),
  quotaPoints: z.number().int().min(1).max(1_000_000).nullable().optional(),
}).strict();
const userGroupsAssignmentSchema = z.object({ groupIds: z.array(uuidSchema).max(100) }).strict();
const workTeamSchema = z.object({
  name: safeText(64),
  description: safeText(300).optional().nullable(),
}).strict();
const workTeamsAssignmentSchema = z.object({ teamIds: z.array(uuidSchema).max(100) }).strict();

@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(
    private prisma: PrismaService,
    private auth: AuthService,
    private storage: StorageService,
    @InjectQueue('image-generation') private queue: Queue,
    @InjectQueue('video-generation') private videoQueue: Queue,
    private authContext: AuthContextService,
    private lifecycle: GenerationLifecycleService,
  ) {}

  @Get('settings')
  async settings() {
    const [trashRow, uploadRow] = await Promise.all([
      this.prisma.systemSetting.findUnique({ where: { key: 'trash_retention' } }),
      this.prisma.systemSetting.findUnique({ where: { key: UPLOAD_IMAGE_SETTING_KEY } }),
    ]);
    return {
      registrationEnabled: await this.auth.registrationEnabled(),
      userSessionDuration: await this.auth.userSessionDuration(),
      adminSessionDuration: '1d',
      trashRetention: trashRetentionFromSetting(trashRow?.value).value,
      uploadMaxLongEdge: uploadImagePolicyFromSetting(uploadRow?.value).maxLongEdge,
    };
  }

  @Patch('settings/registration')
  async registration(@CurrentUser() actor: AuthUser, @Body() raw: unknown) {
    const body = parseBody(registrationSchema, raw);
    await this.prisma.$transaction([
      this.prisma.systemSetting.upsert({ where: { key: 'registration_enabled' }, create: { key: 'registration_enabled', value: body.enabled }, update: { value: body.enabled } }),
      this.prisma.auditLog.create({ data: { actorId: actor.id, action: 'registration.updated', targetType: 'setting', targetId: 'registration_enabled', metadata: { enabled: body.enabled } } }),
    ]);
    return { enabled: body.enabled };
  }

  @Patch('settings/session-duration')
  async sessionDuration(@CurrentUser() actor: AuthUser, @Body() raw: unknown) {
    const body = parseBody(sessionDurationSchema, raw);
    let duration: string;
    try { duration = await this.auth.updateUserSessionDuration(body.duration); }
    catch (error) { throw new BadRequestException((error as Error).message); }
    await this.prisma.auditLog.create({ data: { actorId: actor.id, action: 'session.duration.updated', targetType: 'setting', targetId: 'user_session_duration', metadata: { duration } } });
    return { duration };
  }

  @Patch('settings/trash-retention')
  async trashRetention(@CurrentUser() actor: AuthUser, @Body() raw: unknown) {
    const body = parseBody(trashRetentionSchema, raw);
    let duration: string;
    try { duration = parseTrashRetention(body.duration).value; }
    catch (error) { throw new BadRequestException((error as Error).message); }
    await this.prisma.$transaction([
      this.prisma.systemSetting.upsert({ where: { key: 'trash_retention' }, create: { key: 'trash_retention', value: duration }, update: { value: duration } }),
      this.prisma.auditLog.create({ data: { actorId: actor.id, action: 'trash.retention.updated', targetType: 'setting', targetId: 'trash_retention', metadata: { duration } } }),
    ]);
    return { duration };
  }

  @Patch('settings/upload-image')
  async uploadImage(@CurrentUser() actor: AuthUser, @Body() raw: unknown) {
    const body = parseBody(uploadImageSchema, raw);
    let maxLongEdge: number;
    try { maxLongEdge = parseUploadMaxLongEdge(body.maxLongEdge); }
    catch (error) { throw new BadRequestException((error as Error).message); }
    const value = { maxLongEdge };
    await this.prisma.$transaction([
      this.prisma.systemSetting.upsert({ where: { key: UPLOAD_IMAGE_SETTING_KEY }, create: { key: UPLOAD_IMAGE_SETTING_KEY, value }, update: { value } }),
      this.prisma.auditLog.create({ data: { actorId: actor.id, action: 'upload-image.updated', targetType: 'setting', targetId: UPLOAD_IMAGE_SETTING_KEY, metadata: value } }),
    ]);
    return { maxLongEdge };
  }

  @Get('users')
  async users(@Query('limit') rawLimit?: string, @Query('cursor') rawCursor?: string) {
    const limit = pageLimit(rawLimit, 50);
    const cursor = decodeCursor(rawCursor);
    const users = await this.prisma.user.findMany({
      where: cursorWhere('createdAt', cursor),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: { id: true, username: true, displayName: true, role: true, status: true, mustChangePwd: true, createdAt: true, updatedAt: true, usage: { select: { storageBytes: true } }, mfaCredential: { select: { userId: true } }, groupMemberships: { select: { group: { select: { id: true, name: true } } }, orderBy: { group: { name: 'asc' } } }, teamMemberships: { select: { team: { select: { id: true, name: true } } }, orderBy: { team: { name: 'asc' } } } },
    });
    const hasMore = users.length > limit;
    const page = users.slice(0, limit);
    const items = page.map((user) => {
      const { mfaCredential, groupMemberships, teamMemberships, usage, ...publicUser } = user;
      return { ...publicUser, groups: groupMemberships.map(({ group }) => group), teams: teamMemberships.map(({ team }) => team), mfaEnabled: Boolean(mfaCredential), mfaRequired: user.role === 'ADMIN', storageBytes: usage?.storageBytes.toString() ?? '0' };
    });
    const last = page.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null };
  }

  @Get('user-groups')
  userGroups() {
    return this.prisma.userGroup.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { users: true, models: true } } },
    });
  }

  @Post('user-groups')
  async createUserGroup(@CurrentUser() actor: AuthUser, @Body() raw: unknown) {
    const body = parseBody(userGroupSchema, raw);
    const name = body.name.trim();
    if (await this.prisma.userGroup.findUnique({ where: { name }, select: { id: true } })) throw new ConflictException('用户组名称已存在');
    let quota;
    try { quota = parseQuotaPair(body.quotaWindow ?? null, body.quotaPoints ?? null); }
    catch (error) { throw new BadRequestException((error as Error).message); }
    const group = await this.prisma.userGroup.create({ data: { name, description: body.description?.trim() || null, ...quota } });
    await this.prisma.auditLog.create({ data: { actorId: actor.id, action: 'user-group.created', targetType: 'user-group', targetId: group.id, metadata: { name } } });
    return group;
  }

  @Patch('user-groups/:id')
  async updateUserGroup(@CurrentUser() actor: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() raw: unknown) {
    const body = parseBody(userGroupSchema.partial().strict(), raw);
    const name = body.name?.trim();
    if (name && await this.prisma.userGroup.findFirst({ where: { name, id: { not: id } }, select: { id: true } })) throw new ConflictException('用户组名称已存在');
    let quota = {};
    if (body.quotaWindow !== undefined || body.quotaPoints !== undefined) {
      try { quota = parseQuotaPair(body.quotaWindow ?? null, body.quotaPoints ?? null); }
      catch (error) { throw new BadRequestException((error as Error).message); }
    }
    const group = await this.prisma.userGroup.update({ where: { id }, data: { ...(name ? { name } : {}), ...(body.description !== undefined ? { description: body.description?.trim() || null } : {}), ...quota } });
    await this.prisma.auditLog.create({ data: { actorId: actor.id, action: 'user-group.updated', targetType: 'user-group', targetId: id } });
    return group;
  }

  @Delete('user-groups/:id')
  async deleteUserGroup(@CurrentUser() actor: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    const group = await this.prisma.userGroup.findUniqueOrThrow({ where: { id }, include: { _count: { select: { users: true, models: true } } } });
    if (group._count.users || group._count.models) throw new ConflictException('请先移除该组中的用户和模型权限，再删除用户组');
    await this.prisma.$transaction([
      this.prisma.userGroup.delete({ where: { id } }),
      this.prisma.auditLog.create({ data: { actorId: actor.id, action: 'user-group.deleted', targetType: 'user-group', targetId: id, metadata: { name: group.name } } }),
    ]);
    return { ok: true };
  }

  @Patch('users/:id/groups')
  async userGroupsAssignment(@CurrentUser() actor: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() raw: unknown) {
    const body = parseBody(userGroupsAssignmentSchema, raw);
    const groupIds = [...new Set(body.groupIds)];
    if (groupIds.length !== body.groupIds.length) throw new BadRequestException('用户组不能重复');
    if (groupIds.length && await this.prisma.userGroup.count({ where: { id: { in: groupIds } } }) !== groupIds.length) throw new BadRequestException('包含不存在的用户组');
    await this.prisma.$transaction(async (tx) => {
      await tx.user.findUniqueOrThrow({ where: { id }, select: { id: true } });
      await tx.userGroupMembership.deleteMany({ where: { userId: id } });
      if (groupIds.length) await tx.userGroupMembership.createMany({ data: groupIds.map((groupId) => ({ userId: id, groupId })) });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'user.groups.updated', targetType: 'user', targetId: id, metadata: { groupIds } } });
    });
    await this.authContext.invalidate(id);
    return { groupIds };
  }

  @Get('work-teams')
  workTeams() {
    return this.prisma.workTeam.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { users: true, assetShares: true } } },
    });
  }

  @Post('work-teams')
  async createWorkTeam(@CurrentUser() actor: AuthUser, @Body() raw: unknown) {
    const body = parseBody(workTeamSchema, raw);
    const name = body.name.trim();
    if (await this.prisma.workTeam.findUnique({ where: { name }, select: { id: true } })) throw new ConflictException('工作团队名称已存在');
    const team = await this.prisma.workTeam.create({ data: { name, description: body.description?.trim() || null } });
    await this.prisma.auditLog.create({ data: { actorId: actor.id, action: 'work-team.created', targetType: 'work-team', targetId: team.id, metadata: { name } } });
    return team;
  }

  @Patch('work-teams/:id')
  async updateWorkTeam(@CurrentUser() actor: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() raw: unknown) {
    const body = parseBody(workTeamSchema.partial().strict(), raw);
    const name = body.name?.trim();
    if (name && await this.prisma.workTeam.findFirst({ where: { name, id: { not: id } }, select: { id: true } })) throw new ConflictException('工作团队名称已存在');
    const team = await this.prisma.workTeam.update({ where: { id }, data: { ...(name ? { name } : {}), ...(body.description !== undefined ? { description: body.description?.trim() || null } : {}) } });
    await this.prisma.auditLog.create({ data: { actorId: actor.id, action: 'work-team.updated', targetType: 'work-team', targetId: id } });
    return team;
  }

  @Delete('work-teams/:id')
  async deleteWorkTeam(@CurrentUser() actor: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    const team = await this.prisma.workTeam.findUniqueOrThrow({ where: { id }, include: { _count: { select: { users: true } } } });
    if (team._count.users) throw new ConflictException('请先移除该团队中的用户，再删除工作团队');
    await this.prisma.$transaction([
      this.prisma.workTeam.delete({ where: { id } }),
      this.prisma.auditLog.create({ data: { actorId: actor.id, action: 'work-team.deleted', targetType: 'work-team', targetId: id, metadata: { name: team.name } } }),
    ]);
    return { ok: true };
  }

  @Patch('users/:id/teams')
  async userTeamsAssignment(@CurrentUser() actor: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() raw: unknown) {
    const body = parseBody(workTeamsAssignmentSchema, raw);
    const teamIds = [...new Set(body.teamIds)];
    if (teamIds.length !== body.teamIds.length) throw new BadRequestException('工作团队不能重复');
    if (teamIds.length && await this.prisma.workTeam.count({ where: { id: { in: teamIds } } }) !== teamIds.length) throw new BadRequestException('包含不存在的工作团队');
    await this.prisma.$transaction(async (tx) => {
      await tx.user.findUniqueOrThrow({ where: { id }, select: { id: true } });
      await tx.workTeamMembership.deleteMany({ where: { userId: id } });
      if (teamIds.length) await tx.workTeamMembership.createMany({ data: teamIds.map((teamId) => ({ userId: id, teamId })) });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'user.teams.updated', targetType: 'user', targetId: id, metadata: { teamIds } } });
    });
    await this.authContext.invalidate(id);
    return { teamIds };
  }

  @Patch('users/:id/status')
  async userStatus(@CurrentUser() actor: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() raw: unknown) {
    const body = parseBody(statusSchema, raw);
    if (actor.id === id && body.status !== 'ACTIVE') throw new BadRequestException('不能禁用自己的管理员账号');
    const user = await this.prisma.user.update({ where: { id }, data: { status: body.status }, select: { id: true, username: true, role: true, status: true } });
    await this.authContext.invalidate(id);
    if (body.status !== 'ACTIVE') {
      await this.auth.revokeUser(id);
      await this.cancelActiveJobs(id);
    }
    await this.prisma.auditLog.create({ data: { actorId: actor.id, action: 'user.status.updated', targetType: 'user', targetId: id, metadata: { status: body.status } } });
    return user;
  }

  @Post('users/:id/reset-password')
  async resetPassword(@CurrentUser() actor: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() raw: unknown) {
    const body = parseBody(resetSchema, raw);
    const target = await this.prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (!target) throw new BadRequestException('目标用户不存在');
    let password: string;
    try { password = assertPassword(body.password, target.role); } catch (error) { throw new BadRequestException((error as Error).message); }
    await this.prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(password), mustChangePwd: true } });
    await this.auth.revokeUser(id);
    await this.prisma.auditLog.create({ data: { actorId: actor.id, action: 'user.password.reset', targetType: 'user', targetId: id } });
    return { ok: true };
  }

  @Post('users/:id/reset-mfa')
  async resetMfa(@CurrentUser() actor: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() raw: unknown) {
    const body = parseBody(resetMfaSchema, raw);
    await this.auth.adminResetMfa(actor.id, id, body.actorCode);
    return { ok: true };
  }

  @Delete('users/:id')
  async deleteUser(@CurrentUser() actor: AuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    if (actor.id === id) throw new BadRequestException('不能删除自己的管理员账号');
    const user = await this.prisma.user.update({ where: { id }, data: { status: 'DELETING' }, select: { id: true } });
    await this.auth.revokeUser(user.id);
    await this.cancelActiveJobs(id);
    await this.storage.deleteUser(id);
    await this.prisma.$transaction([
      this.prisma.user.delete({ where: { id } }),
      this.prisma.auditLog.create({ data: { actorId: actor.id, action: 'user.deleted', targetType: 'user', targetId: id } }),
    ]);
    return { ok: true };
  }

  @Get('storage')
  async storageStats() {
    const result = await this.prisma.asset.aggregate({ where: { role: { in: ['UPLOAD', 'OUTPUT'] }, purgedAt: null }, _sum: { sizeBytes: true }, _count: true });
    return { assetCount: result._count, storageBytes: result._sum.sizeBytes?.toString() ?? '0' };
  }

  @Get('usage')
  async usage(@Query('from') rawFrom?: string, @Query('to') rawTo?: string) {
    const { from, to } = parseUsageRange(rawFrom, rawTo);
    const rows = await this.prisma.quotaEvent.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: from, lt: to } },
      _sum: { imageCount: true, videoSeconds: true, points: true },
      _count: { _all: true },
    });
    const users = rows.length ? await this.prisma.user.findMany({
      where: { id: { in: rows.map((row) => row.userId) } },
      select: { id: true, username: true, displayName: true },
    }) : [];
    const byId = new Map(users.map((user) => [user.id, user]));
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      items: rows
        .map((row) => ({
          userId: row.userId,
          username: byId.get(row.userId)?.username ?? '',
          displayName: byId.get(row.userId)?.displayName ?? byId.get(row.userId)?.username ?? '',
          imageCount: row._sum.imageCount ?? 0,
          videoSeconds: row._sum.videoSeconds ?? 0,
          points: row._sum.points ?? 0,
          events: row._count._all,
        }))
        .sort((left, right) => right.points - left.points || right.imageCount - left.imageCount || left.username.localeCompare(right.username)),
    };
  }

  @Get('audit-logs')
  auditLogs() {
    return this.prisma.auditLog.findMany({ take: 200, orderBy: { createdAt: 'desc' }, select: { id: true, action: true, targetType: true, targetId: true, metadata: true, createdAt: true, actor: { select: { username: true } } } });
  }

  private async cancelActiveJobs(userId: string) {
    const jobs = await this.prisma.generationJob.findMany({
      where: { userId, status: { in: [...ACTIVE_JOB_STATUSES] } },
      select: { id: true, status: true },
    });
    const queuedIds = new Set(jobs.filter((job) => job.status === 'QUEUED').map((job) => job.id));
    if (queuedIds.size > 0) {
      const queues = [this.queue, this.videoQueue].filter(Boolean);
      for (const queue of queues) {
        const queuedJobs = await queue.getJobs(['waiting', 'delayed', 'prioritized'], 0, -1, true);
        const matchingQueueJobs = queuedJobs.filter((queueJob) => queuedIds.has(String(queueJob.data?.jobId)));
        for (let index = 0; index < matchingQueueJobs.length; index += 8) {
          await Promise.all(matchingQueueJobs.slice(index, index + 8).map(async (queueJob) => {
            try { await queueJob.remove(); }
            catch { /* A worker may already have claimed or removed the job. */ }
          }));
        }
      }
    }
    await this.prisma.generationJob.updateMany({
      where: { userId, status: { in: [...ACTIVE_JOB_STATUSES] } },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    await Promise.all(jobs.map(async (job) => {
      await this.lifecycle.releaseAndPublish(userId, job.id);
    }));
  }
}

function parseUsageRange(rawFrom?: string, rawTo?: string) {
  const today = new Date();
  const defaultTo = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1);
  const defaultFrom = defaultTo - 7 * 24 * 60 * 60 * 1000;
  const from = parseUtcDay(rawFrom, new Date(defaultFrom));
  const to = rawTo ? new Date(parseUtcDay(rawTo, new Date(defaultTo)).getTime() + 24 * 60 * 60 * 1000) : new Date(defaultTo);
  if (from.getTime() >= to.getTime()) throw new BadRequestException('用量起始日期必须早于结束日期');
  return { from, to };
}

function parseUtcDay(raw: string | undefined, fallback: Date) {
  if (!raw) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new BadRequestException('日期格式必须为 YYYY-MM-DD');
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) throw new BadRequestException('日期格式必须为 YYYY-MM-DD');
  return date;
}
