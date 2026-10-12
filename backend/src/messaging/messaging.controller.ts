import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/jwt.strategy';
import { ActingUser } from '../common/authz/policy';
import { Roles } from '../common/authz/roles.decorator';
import { RolesGuard } from '../common/authz/roles.guard';
import { SendMessageDto } from './dto/send-message.dto';
import { MessageView, MessagingService } from './messaging.service';

function acting(user: AuthenticatedUser): ActingUser {
  return { id: user.id, role: user.role as Role };
}

@Controller('consultations/:id/messages')
@UseGuards(JwtAuthGuard, RolesGuard)
// Admin is intentionally absent — admins cannot read clinical content (invariant 3).
@Roles(Role.PATIENT, Role.NURSE, Role.DOCTOR)
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Post()
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
  ): Promise<MessageView> {
    return this.messaging.send(acting(user), id, dto);
  }

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MessageView[]> {
    return this.messaging.list(acting(user), id);
  }
}
