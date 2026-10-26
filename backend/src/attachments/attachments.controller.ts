import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/jwt.strategy';
import { ActingUser } from '../common/authz/policy';
import { Roles } from '../common/authz/roles.decorator';
import { RolesGuard } from '../common/authz/roles.guard';
import { UploadThrottle } from '../common/throttler/throttler.config';
import {
  AttachmentsService,
  AttachmentView,
  AttachmentWithUrl,
  UploadedFile as UploadedFileData,
} from './attachments.service';
import { MulterExceptionFilter } from './multer-exception.filter';

/** Hard ceiling enforced by multer; the finer configurable cap lives in the service. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function acting(user: AuthenticatedUser): ActingUser {
  return { id: user.id, role: user.role as Role };
}

/**
 * Attachment upload + listing, nested under a consultation. Clinical content, so
 * admin is intentionally absent from the role gate (invariant 3) and the service
 * additionally enforces participant ownership + IN_SESSION for upload.
 */
@Controller('consultations/:id/attachments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.PATIENT, Role.NURSE, Role.DOCTOR)
export class ConsultationAttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post()
  @UploadThrottle()
  @UseFilters(MulterExceptionFilter)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedFileData | undefined,
  ): Promise<AttachmentView> {
    if (!file) {
      // No file part in the multipart body.
      throw new BadRequestException('A file is required');
    }
    return this.attachments.upload(acting(user), id, file);
  }

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AttachmentWithUrl[]> {
    return this.attachments.list(acting(user), id);
  }

  /** The patient removes a file they shared by mistake, during the session (ADR-0028). */
  @Delete(':attachmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ): Promise<void> {
    return this.attachments.remove(acting(user), id, attachmentId);
  }
}

/**
 * Signed-URL download. This route is authorized by the token itself (so it can be
 * used as a plain URL, e.g. an <img> src), NOT by a bearer JWT: the service
 * verifies the token, re-loads the bound user, confirms the account is active, and
 * re-runs the authorization matrix — an admin or non-participant is refused even
 * with a valid link (ADR-0007, invariant 3). No PII/clinical data is in the query.
 */
@Controller('attachments')
export class AttachmentDownloadController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get(':id/download')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.attachments.resolveDownload(id, token);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', file.sizeBytes);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
    // Signed URLs are user-scoped and short-lived — never let a shared cache store them.
    res.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(file.stream);
  }
}
