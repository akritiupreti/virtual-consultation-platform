import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConsultationState, UserStatus } from '@prisma/client';
import type { ReadStream } from 'node:fs';
import { AUDIT_EVENTS } from '../audit/audit-events';
import { AuditService } from '../audit/audit.service';
import { Action } from '../common/authz/authorization-matrix';
import { ActingUser, authorizeConsultationAction } from '../common/authz/policy';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { AttachmentStorageService } from './attachment-storage.service';
import { resolveAttachmentMime } from './file-validation';
import { SignedUrlService } from './signed-url.service';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB (C4)
const DEFAULT_MAX_PER_CONSULTATION = 10;

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface AttachmentView {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: Date;
}

export interface AttachmentWithUrl extends AttachmentView {
  /** Short-lived, user-scoped download URL (relative to the API base). */
  downloadUrl: string;
  expiresAt: Date;
}

export interface AttachmentDownload {
  stream: ReadStream;
  mimeType: string;
  filename: string;
  sizeBytes: number;
}

@Injectable()
export class AttachmentsService {
  private readonly maxBytes: number;
  private readonly maxPerConsultation: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: AttachmentStorageService,
    private readonly signedUrl: SignedUrlService,
    config: ConfigService,
    private readonly realtime: RealtimeService,
  ) {
    this.maxBytes = positiveIntOr(config.get('ATTACHMENT_MAX_BYTES'), DEFAULT_MAX_BYTES);
    this.maxPerConsultation = positiveIntOr(
      config.get('ATTACHMENT_MAX_PER_CONSULTATION'),
      DEFAULT_MAX_PER_CONSULTATION,
    );
  }

  /**
   * Upload an attachment to a consultation. Participants only (matrix), and only
   * while IN_SESSION (mirrors messaging). The file's real type is sniffed from its
   * bytes (JPEG/PNG/PDF only), the size and per-consultation count are capped, and
   * it is stored under an opaque key — never the client filename. Audited as
   * ATTACHMENT_UPLOADED with who/what/when only (id, type, size — never the bytes).
   */
  async upload(
    user: ActingUser,
    consultationId: string,
    file: UploadedFile,
  ): Promise<AttachmentView> {
    const consultation = await this.loadConsultationOr404(consultationId);
    authorizeConsultationAction(user, consultation, Action.UPLOAD_ATTACHMENT);

    if (consultation.state !== ConsultationState.IN_SESSION) {
      throw new ConflictException('Attachments can only be shared during an active session');
    }
    if (file.size > this.maxBytes) {
      throw new PayloadTooLargeException(`File exceeds the ${this.maxBytes}-byte limit`);
    }

    const count = await this.prisma.attachment.count({ where: { consultationId } });
    if (count >= this.maxPerConsultation) {
      throw new ConflictException(
        `This consultation already has the maximum of ${this.maxPerConsultation} attachments`,
      );
    }

    // Validate the real content type (throws 415 if not an allowed JPEG/PNG/PDF).
    const mimeType = resolveAttachmentMime(file.buffer, file.mimetype);
    const storageKey = await this.storage.save(file.buffer);

    const attachment = await this.prisma.attachment.create({
      data: {
        consultationId,
        uploadedBy: user.id,
        filename: sanitizeFilename(file.originalname),
        mimeType,
        sizeBytes: file.size,
        storageKey,
      },
    });

    await this.audit.record({
      actorId: user.id,
      eventType: AUDIT_EVENTS.ATTACHMENT_UPLOADED,
      consultationId,
      // Who/what/when only: no filename (may carry PII) and never the file bytes.
      metadata: { attachmentId: attachment.id, mimeType, sizeBytes: file.size },
    });
    // Let the other participant's open room show the file without a refresh. The
    // signal is content-free; they re-fetch the list through the matrix (ADR-0027).
    this.realtime.notifyAttachmentCreated(consultationId);

    return toView(attachment);
  }

  /**
   * List a consultation's attachments (metadata) with a freshly-minted, short-lived
   * signed download URL for each. Participants only — an admin is denied by the
   * matrix (separation of duties, SC-6). The signed URL carries no PII/clinical
   * data; it binds the download to this user for a short window (ADR-0007).
   */
  async list(user: ActingUser, consultationId: string): Promise<AttachmentWithUrl[]> {
    const consultation = await this.loadConsultationOr404(consultationId);
    authorizeConsultationAction(user, consultation, Action.VIEW_ATTACHMENT);

    const attachments = await this.prisma.attachment.findMany({
      where: { consultationId },
      orderBy: { createdAt: 'asc' },
    });

    return attachments.map((attachment) => {
      const { token, expiresAt } = this.signedUrl.sign(attachment.id, user.id);
      return {
        ...toView(attachment),
        downloadUrl: `/attachments/${attachment.id}/download?token=${token}`,
        expiresAt,
      };
    });
  }

  /**
   * Resolve a signed download token to a readable file. The token alone does NOT
   * grant access: it is verified (signature + expiry), then the bound user is
   * re-loaded and must still be ACTIVE, and the full authorization check runs
   * again (role → state → ownership) so an admin or non-participant is refused even
   * with a valid link (invariant 3). Every access is audited.
   */
  async resolveDownload(attachmentId: string, token: string): Promise<AttachmentDownload> {
    const claims = this.signedUrl.verify(token);
    if (!claims || claims.attachmentId !== attachmentId) {
      throw new ForbiddenException('Invalid or expired download link');
    }

    const user = await this.prisma.user.findUnique({ where: { id: claims.userId } });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('Invalid or expired download link');
    }

    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: {
        consultation: { select: { patientId: true, claimedBy: true, state: true } },
      },
    });
    if (!attachment) {
      throw new NotFoundException('Attachment not found');
    }

    // Re-authorize on every fetch — the signed URL never bypasses the matrix.
    authorizeConsultationAction(
      { id: user.id, role: user.role },
      attachment.consultation,
      Action.VIEW_ATTACHMENT,
    );

    await this.audit.record({
      actorId: user.id,
      eventType: AUDIT_EVENTS.ATTACHMENT_ACCESSED,
      consultationId: attachment.consultationId,
      metadata: { attachmentId: attachment.id },
    });

    return {
      stream: this.storage.openStream(attachment.storageKey),
      mimeType: attachment.mimeType,
      filename: attachment.filename,
      sizeBytes: attachment.sizeBytes,
    };
  }

  private async loadConsultationOr404(
    id: string,
  ): Promise<{ patientId: string; claimedBy: string | null; state: ConsultationState }> {
    const consultation = await this.prisma.consultation.findUnique({
      where: { id },
      select: { patientId: true, claimedBy: true, state: true },
    });
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    return consultation;
  }
}

function toView(attachment: {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: Date;
}): AttachmentView {
  return {
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    uploadedBy: attachment.uploadedBy,
    createdAt: attachment.createdAt,
  };
}

/** Strip any path components and bound the length; keep a safe display name. */
function sanitizeFilename(name: string): string {
  const withoutPath = (name ?? 'file').replace(/^.*[\\/]/, '');
  // Drop control characters without a control-character regex (lint-safe).
  const cleaned = Array.from(withoutPath)
    .filter((ch) => ch.charCodeAt(0) >= 0x20)
    .join('');
  const trimmed = cleaned.trim().slice(0, 200);
  return trimmed.length > 0 ? trimmed : 'file';
}

function positiveIntOr(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
