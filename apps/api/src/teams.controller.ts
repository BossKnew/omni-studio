import { Controller, Get } from '@nestjs/common';
import { CurrentUser, type AuthUser } from './common';
import { PrismaService } from './prisma.service';

@Controller('teams')
export class TeamsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.prisma.workTeam.findMany({
      where: user.role === 'ADMIN' ? undefined : { id: { in: user.teamIds } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  }
}
