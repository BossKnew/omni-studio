import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleInit, Optional, UnauthorizedException } from '@nestjs/common';
import { UserStatus } from './generated/prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { assertPassword, cleanUsername } from './common';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';
import { RateLimitService } from './rate-limit.service';
import { securityConfig } from './security-config';
import { MfaService } from './mfa.service';
import { ADMIN_SESSION_SECONDS, DEFAULT_USER_SESSION_DURATION, parseSessionDuration, SESSION_INDEX_SECONDS } from './session-duration';
import { hashPassword, verifyPassword } from './password-hash';
import { AuthContextService } from './auth-context.service';
import { SESSION_PREFIX, USER_SESSIONS_PREFIX } from './domain-constants';

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash = '';
  private readonly logger = new Logger(AuthService.name);
  constructor(private prisma: PrismaService, private redis: RedisService, private limits: RateLimitService, private mfa: MfaService, @Optional() private authContext?: AuthContextService) {}

  async onModuleInit() {
    this.dummyHash = await hashPassword(randomBytes(32));
    await this.prisma.systemSetting.upsert({
      where: { key: 'registration_enabled' },
      create: { key: 'registration_enabled', value: false },
      update: {},
    });
    await this.prisma.systemSetting.upsert({
      where: { key: 'user_session_duration' },
      create: { key: 'user_session_duration', value: DEFAULT_USER_SESSION_DURATION },
      update: {},
    });
    const username = process.env.BOOTSTRAP_ADMIN_USERNAME;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (username && password) {
      const normalized = cleanUsername(username);
      const existing = await this.prisma.user.findUnique({ where: { username: normalized } });
      if (!existing) {
        await this.prisma.user.create({ data: {
          username: normalized,
          passwordHash: await hashPassword(assertPassword(password)),
          role: 'ADMIN', status: 'ACTIVE', mustChangePwd: true,
          usage: { create: {} },
        }});
      }
    }
  }

  async registrationEnabled() {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'registration_enabled' } });
    return row?.value === true;
  }

  async userSessionDuration() {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'user_session_duration' } });
    try { return parseSessionDuration(row?.value).value; } catch { return DEFAULT_USER_SESSION_DURATION; }
  }

  async updateUserSessionDuration(value: string) {
    const duration = parseSessionDuration(value);
    await this.prisma.systemSetting.upsert({ where: { key: 'user_session_duration' }, create: { key: 'user_session_duration', value: duration.value }, update: { value: duration.value } });
    return duration.value;
  }

  async register(rawUsername: string, rawPassword: string, ip = 'unknown') {
    await this.limits.consume('register-ip', ip, securityConfig.registrationLimit(), 3600);
    if (!(await this.registrationEnabled())) throw new ForbiddenException('管理员暂未开放注册');
    try {
      const username = cleanUsername(rawUsername);
      const password = assertPassword(rawPassword, 'USER');
      await this.prisma.user.create({ data: { username, passwordHash: await hashPassword(password), usage: { create: {} } } });
      return { status: 'PENDING', message: '注册成功，等待管理员激活' };
    } catch (error: any) {
      if (error?.code === 'P2002') throw new BadRequestException('用户名已存在');
      throw new BadRequestException(error instanceof Error ? error.message : '注册失败');
    }
  }

  async login(rawUsername: string, rawPassword: string, ip = 'unknown', remember = false) {
    let username: string;
    try { username = cleanUsername(rawUsername); } catch { throw new UnauthorizedException('用户名或密码错误'); }
    await this.limits.consume('login-ip', ip, securityConfig.loginIpLimit(), 600);
    await this.limits.consume('login-pair', `${ip}\0${username}`, securityConfig.loginPairLimit(), 600);
    await this.limits.assertAvailable('login-account-failure', username, securityConfig.loginAccountFailureLimit());
    const user = await this.prisma.user.findUnique({ where: { username }, include: { mfaCredential: { select: { userId: true } } } });
    const password = rawPassword;
    const valid = await verifyPassword(user?.passwordHash ?? this.dummyHash, password).catch(() => false);
    if (user && valid) await this.limits.clear('login-account-failure', username);
    if (!user || !valid) {
      this.logger.warn(`login failed identity=${this.limits.keyPart(`${ip}\0${username}`)}`);
      await this.limits.recordFailure('login-account-failure', username, securityConfig.loginAccountFailureLimit(), 600);
      throw new UnauthorizedException('用户名或密码错误');
    }
    if (user.status !== UserStatus.ACTIVE) throw new ForbiddenException(`账号状态：${user.status}`);
    if (user.mfaCredential) {
      const challenge = await this.mfa.createLoginChallenge(user.id, remember);
      this.logger.log(`login password verified userId=${user.id} source=${this.limits.keyPart(ip)}`);
      return { next: 'MFA_REQUIRED' as const, challenge };
    }
    if (user.mustChangePwd) {
      const session = await this.createSession(user, 'PASSWORD_CHANGE', false, undefined, remember);
      return { next: 'PASSWORD_CHANGE_REQUIRED' as const, session };
    }
    if (this.mfa.requiredFor(user.role)) {
      const challenge = await this.mfa.createSetupChallenge(user.id, false, remember);
      this.logger.log(`login mfa enrollment required userId=${user.id} source=${this.limits.keyPart(ip)}`);
      return { next: 'MFA_ENROLLMENT_REQUIRED' as const, challenge };
    }
    const session = await this.createSession(user, 'FULL', false, undefined, remember);
    return { next: 'AUTHENTICATED' as const, session };
  }

  async completeMfaLogin(token: string | undefined, code: string, kind: 'totp' | 'recovery', ip: string) {
    const verified = await this.mfa.verifyLoginChallenge(token, code, kind, ip);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: verified.userId }, include: { mfaCredential: { select: { userId: true } } } });
    if (user.status !== UserStatus.ACTIVE) throw new ForbiddenException(`账号状态：${user.status}`);
    const stage = user.mustChangePwd ? 'PASSWORD_CHANGE' : 'FULL';
    const session = await this.createSession(user, stage, true, verified.method, verified.remember);
    this.logger.log(`login succeeded userId=${user.id} source=${this.limits.keyPart(ip)} mfa=${verified.method}`);
    return { next: user.mustChangePwd ? 'PASSWORD_CHANGE_REQUIRED' as const : 'AUTHENTICATED' as const, session };
  }

  setupInfo(token: string | undefined) { return this.mfa.setupInfo(token); }

  async beginMfaSetup(userId: string, currentPassword: string, currentCode?: string, kind: 'totp' | 'recovery' = 'totp') {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { mfaCredential: { select: { userId: true } } } });
    if (!(await verifyPassword(user.passwordHash, currentPassword).catch(() => false))) throw new UnauthorizedException('当前密码错误');
    if (user.mfaCredential && (!currentCode || !(await this.mfa.verifyCurrentFactor(userId, currentCode, kind)))) throw new UnauthorizedException('动态码或恢复码无效');
    return this.mfa.createSetupChallenge(userId, Boolean(user.mfaCredential));
  }

  async confirmMfaSetup(token: string | undefined, code: string) {
    const result = await this.mfa.confirmSetup(token, code);
    await this.revokeUser(result.userId);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: result.userId }, include: { mfaCredential: { select: { userId: true } } } });
    const session = await this.createSession(user, user.mustChangePwd ? 'PASSWORD_CHANGE' : 'FULL', true, 'totp', result.remember);
    return { next: user.mustChangePwd ? 'PASSWORD_CHANGE_REQUIRED' as const : 'AUTHENTICATED' as const, recoveryCodes: result.recoveryCodes, session };
  }

  async disableMfa(userId: string, currentPassword: string, code: string, kind: 'totp' | 'recovery') {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (this.mfa.requiredFor(user.role)) throw new ForbiddenException('管理员必须启用双重验证');
    if (!(await verifyPassword(user.passwordHash, currentPassword).catch(() => false))) throw new UnauthorizedException('当前密码错误');
    if (!(await this.mfa.verifyCurrentFactor(userId, code, kind))) throw new UnauthorizedException('动态码或恢复码无效');
    await this.mfa.removeCredential(userId);
    await this.revokeUser(userId);
  }

  async regenerateRecoveryCodes(userId: string, currentPassword: string, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(user.passwordHash, currentPassword).catch(() => false))) throw new UnauthorizedException('当前密码错误');
    if (!(await this.mfa.verifyCurrentFactor(userId, code, 'totp'))) throw new UnauthorizedException('动态码无效');
    const recoveryCodes = await this.mfa.regenerateRecoveryCodes(userId);
    await this.revokeUser(userId);
    return recoveryCodes;
  }

  async adminResetMfa(actorId: string, targetId: string, actorCode: string) {
    if (actorId === targetId) throw new BadRequestException('不能通过管理员接口重置自己的双重验证');
    const target = await this.prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!target) throw new BadRequestException('目标用户不存在');
    if (!(await this.mfa.verifyCurrentFactor(actorId, actorCode, 'totp'))) throw new UnauthorizedException('管理员动态码无效或已使用');
    await this.mfa.removeCredential(targetId, actorId, 'admin.user.mfa.reset');
    await this.revokeUser(targetId);
  }

  private async createSession(user: any, stage: 'FULL' | 'PASSWORD_CHANGE', mfaAuthenticated: boolean, mfaMethod?: 'totp' | 'recovery', remember = false) {
    const policy = await this.sessionPolicy(user.role, remember);
    const token = randomBytes(32).toString('base64url');
    const digest = this.sessionDigest(token);
    const csrfToken = randomBytes(32).toString('base64url');
    const sessionsKey = `${USER_SESSIONS_PREFIX}${user.id}`;
    await this.redis.client.multi()
      .set(`${SESSION_PREFIX}${digest}`, JSON.stringify({ userId: user.id, csrfToken, stage, mfaAuthenticated, mfaMethod, mfaVerifiedAt: mfaAuthenticated ? Date.now() : undefined }), 'EX', policy.ttlSeconds)
      .zadd(sessionsKey, Date.now(), digest)
      .expire(sessionsKey, SESSION_INDEX_SECONDS)
      .exec();
    const expired = await this.redis.client.zrange(sessionsKey, '0', '-11');
    if (expired.length) {
      const tx = this.redis.client.multi().zrem(sessionsKey, ...expired);
      expired.forEach((item) => tx.del(`${SESSION_PREFIX}${item}`));
      await tx.exec();
    }
    return { token, csrfToken, maxAgeMs: policy.persistent ? policy.ttlSeconds * 1000 : undefined, expiresInSeconds: policy.ttlSeconds, user: this.publicUser(user) };
  }

  private async sessionPolicy(role: string, remember: boolean) {
    if (role === 'ADMIN') return { ttlSeconds: ADMIN_SESSION_SECONDS, persistent: true };
    if (!remember) return { ttlSeconds: ADMIN_SESSION_SECONDS, persistent: false };
    const configured = parseSessionDuration(await this.userSessionDuration());
    return { ttlSeconds: configured.seconds, persistent: true };
  }

  async changePassword(userId: string, currentPassword: unknown, rawPassword: unknown) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (typeof currentPassword !== 'string' || !(await verifyPassword(user.passwordHash, currentPassword))) throw new UnauthorizedException('当前密码错误');
    let password: string;
    try { password = assertPassword(rawPassword, user.role); } catch (error) { throw new BadRequestException((error as Error).message); }
    if (currentPassword === password) throw new BadRequestException('新密码不能与当前密码相同');
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(password), mustChangePwd: false } });
    await this.prisma.auditLog.create({ data: { actorId: userId, action: 'user.password.changed', targetType: 'user', targetId: userId } });
    await this.revokeUser(userId);
  }

  async updateProfile(userId: string, displayName: string) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { displayName },
      include: { mfaCredential: { select: { userId: true } } },
    });
    await this.prisma.auditLog.create({ data: { actorId: userId, action: 'user.profile.updated', targetType: 'user', targetId: userId } });
    await this.authContext?.invalidate(userId);
    return this.publicUser(user);
  }

  async logout(token?: string) {
    if (!token) return;
    const digest = this.sessionDigest(token);
    const raw = await this.redis.client.get(`${SESSION_PREFIX}${digest}`);
    const userId = raw ? JSON.parse(raw).userId : undefined;
    const tx = this.redis.client.multi().del(`${SESSION_PREFIX}${digest}`);
    if (userId) tx.zrem(`${USER_SESSIONS_PREFIX}${userId}`, digest);
    await tx.exec();
  }

  async revokeUser(userId: string) {
    const tokens = await this.redis.client.zrange(`${USER_SESSIONS_PREFIX}${userId}`, '0', '-1');
    const tx = this.redis.client.multi();
    tokens.forEach((token) => tx.del(`${SESSION_PREFIX}${token}`));
    tx.del(`${USER_SESSIONS_PREFIX}${userId}`);
    await tx.exec();
    await this.authContext?.invalidate(userId);
  }

  publicUser(user: any) {
    const mfaEnabled = Boolean(user.mfaCredential);
    return { id: user.id, username: user.username, displayName: user.displayName ?? user.username, role: user.role, status: user.status, mustChangePwd: user.mustChangePwd, mfaEnabled, mfaRequired: this.mfa.requiredFor(user.role) };
  }

  sessionDigest(token: string) { return createHash('sha256').update(token).digest('base64url'); }
}
