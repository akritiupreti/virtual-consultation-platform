import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/jwt.strategy';
import { ActingUser } from '../common/authz/policy';
import { Roles } from '../common/authz/roles.decorator';
import { RolesGuard } from '../common/authz/roles.guard';
import {
  AssignedConsultationView,
  ConsultationsService,
  ConsultationView,
  MyConsultationView,
  PendingSignoffView,
  QueueItem,
  SignedOffView,
} from './consultations.service';
import { SetPriorityDto } from './dto/set-priority.dto';
import { SubmitRequestDto } from './dto/submit-request.dto';

function acting(user: AuthenticatedUser): ActingUser {
  return { id: user.id, role: user.role as Role };
}

@Controller('consultations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ConsultationsController {
  constructor(private readonly consultations: ConsultationsService) {}

  @Post()
  @Roles(Role.PATIENT)
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SubmitRequestDto,
  ): Promise<MyConsultationView> {
    return this.consultations.submitRequest(acting(user), dto);
  }

  // Declared before `:id` so these literal paths are not captured as an id.
  @Get('queue')
  @Roles(Role.NURSE, Role.DOCTOR)
  queue(): Promise<QueueItem[]> {
    return this.consultations.getQueue();
  }

  @Get('mine')
  @Roles(Role.PATIENT)
  mine(@CurrentUser() user: AuthenticatedUser): Promise<MyConsultationView[]> {
    return this.consultations.getMine(acting(user));
  }

  @Get('assigned')
  @Roles(Role.NURSE, Role.DOCTOR)
  assigned(@CurrentUser() user: AuthenticatedUser): Promise<AssignedConsultationView[]> {
    return this.consultations.getAssigned(acting(user));
  }

  // Doctor sign-off worklist: ENDED cases with a drafted-but-unfinalized summary
  // (typically nurse-run). Declared before `:id` so the literal path is not an id.
  @Get('pending-signoff')
  @Roles(Role.DOCTOR)
  pendingSignoff(): Promise<PendingSignoffView[]> {
    return this.consultations.getPendingSignoff();
  }

  // The calling doctor's own completed sign-offs (ADR-0009). Before `:id` as above.
  @Get('signed-off')
  @Roles(Role.DOCTOR)
  signedOff(@CurrentUser() user: AuthenticatedUser): Promise<SignedOffView[]> {
    return this.consultations.getSignedOff(acting(user));
  }

  @Get(':id')
  @Roles(Role.PATIENT, Role.NURSE, Role.DOCTOR)
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConsultationView> {
    return this.consultations.getOne(acting(user), id);
  }

  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.NURSE, Role.DOCTOR)
  claim(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConsultationView> {
    return this.consultations.claim(acting(user), id);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.NURSE, Role.DOCTOR)
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConsultationView> {
    return this.consultations.start(acting(user), id);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.NURSE, Role.DOCTOR)
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConsultationView> {
    return this.consultations.complete(acting(user), id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.PATIENT)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConsultationView> {
    return this.consultations.cancel(acting(user), id);
  }

  @Patch(':id/priority')
  @Roles(Role.NURSE, Role.DOCTOR)
  setPriority(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetPriorityDto,
  ): Promise<{ id: string; state: string; priority: string }> {
    return this.consultations.setPriority(acting(user), id, dto.priority);
  }
}
