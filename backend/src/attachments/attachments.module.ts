import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AttachmentStorageService } from './attachment-storage.service';
import {
  AttachmentDownloadController,
  ConsultationAttachmentsController,
} from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { SignedUrlService } from './signed-url.service';

/**
 * AttachmentsModule owns upload, listing, and signed-URL download of clinical
 * attachments (ADR-0007). Access is participant-scoped and never admin; files live
 * in a local object store and are reachable only via short-lived, user-scoped
 * signed URLs that still pass through the authorization matrix on every fetch.
 */
@Module({
  imports: [AuditModule],
  controllers: [ConsultationAttachmentsController, AttachmentDownloadController],
  providers: [AttachmentsService, SignedUrlService, AttachmentStorageService],
})
export class AttachmentsModule {}
