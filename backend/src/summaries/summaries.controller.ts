import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { AddAddendumDto } from './dto/add-addendum.dto';
import { DraftSummaryDto } from './dto/draft-summary.dto';
import { SummariesService, SummaryView } from './summaries.service';

function acting(user: AuthenticatedUser): ActingUser {
  return { id: user.id, role: user.role as Role };
}

@Controller('consultations/:id/summary')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SummariesController {
  constructor(private readonly summaries: SummariesService) {}

  @Post()
  @Roles(Role.NURSE, Role.DOCTOR)
  draft(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DraftSummaryDto,
  ): Promise<SummaryView> {
    return this.summaries.draft(acting(user), id, dto);
  }

  @Post('finalize')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.DOCTOR)
  finalize(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SummaryView> {
    return this.summaries.finalize(acting(user), id);
  }

  @Post('addendum')
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.NURSE, Role.DOCTOR)
  addAddendum(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddAddendumDto,
  ): Promise<SummaryView> {
    return this.summaries.addAddendum(acting(user), id, dto);
  }

  @Get()
  @Roles(Role.PATIENT, Role.NURSE, Role.DOCTOR)
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SummaryView> {
    return this.summaries.get(acting(user), id);
  }
}
