import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConsultationState, Role, UserStatus } from '@prisma/client';
import { AttachmentsService } from '../src/attachments/attachments.service';

/**
 * Unit coverage for the attachment guards and the signed-URL download
 * re-authorization path (ADR-0007 / invariant 3) — size/count caps and the
 * token→user→matrix re-check that stops a valid link from bypassing authz.
 */
function build() {
  const prisma = {
    consultation: { findUnique: jest.fn() },
    attachment: { count: jest.fn(), create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    user: { findUnique: jest.fn() },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const storage = { save: jest.fn(), openStream: jest.fn() };
  const signedUrl = { verify: jest.fn(), sign: jest.fn(), ttl: 300 };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const service = new AttachmentsService(
    prisma as never,
    audit as never,
    storage as never,
    signedUrl as never,
    config as never,
  );
  return { service, prisma, audit, storage, signedUrl };
}

const participant = { id: 'pat', role: Role.PATIENT };
const inSession = { patientId: 'pat', claimedBy: 'doc', state: ConsultationState.IN_SESSION };

describe('AttachmentsService (unit)', () => {
  it('404s when the consultation does not exist', async () => {
    const { service, prisma } = build();
    prisma.consultation.findUnique.mockResolvedValue(null);
    await expect(service.list(participant, 'c-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a file over the size cap (413)', async () => {
    const { service, prisma } = build();
    prisma.consultation.findUnique.mockResolvedValue(inSession);
    await expect(
      service.upload(participant, 'c-1', {
        buffer: Buffer.from('x'),
        originalname: 'big.png',
        mimetype: 'image/png',
        size: 10 * 1024 * 1024 + 1,
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('rejects uploads once the per-consultation cap is reached (409)', async () => {
    const { service, prisma } = build();
    prisma.consultation.findUnique.mockResolvedValue(inSession);
    prisma.attachment.count.mockResolvedValue(10);
    await expect(
      service.upload(participant, 'c-1', {
        buffer: Buffer.from('x'),
        originalname: 'f.png',
        mimetype: 'image/png',
        size: 10,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects an upload outside an active session (409)', async () => {
    const { service, prisma } = build();
    prisma.consultation.findUnique.mockResolvedValue({
      ...inSession,
      state: ConsultationState.ENDED,
    });
    await expect(
      service.upload(participant, 'c-1', {
        buffer: Buffer.from('x'),
        originalname: 'f.png',
        mimetype: 'image/png',
        size: 10,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('lists attachments with freshly-minted signed URLs', async () => {
    const { service, prisma, signedUrl } = build();
    prisma.consultation.findUnique.mockResolvedValue(inSession);
    prisma.attachment.findMany.mockResolvedValue([
      {
        id: 'a-1',
        filename: 'f.png',
        mimeType: 'image/png',
        sizeBytes: 5,
        uploadedBy: 'pat',
        createdAt: new Date(),
      },
    ]);
    signedUrl.sign.mockReturnValue({ token: 'tok', expiresAt: new Date() });
    const views = await service.list(participant, 'c-1');
    expect(views[0].downloadUrl).toContain('token=tok');
  });

  it('rejects a tampered/mismatched download token (403)', async () => {
    const { service, signedUrl } = build();
    signedUrl.verify.mockReturnValue(null);
    await expect(service.resolveDownload('a-1', 'bad')).rejects.toBeInstanceOf(ForbiddenException);
    signedUrl.verify.mockReturnValue({ attachmentId: 'other', userId: 'pat', exp: 0 });
    await expect(service.resolveDownload('a-1', 'tok')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a download when the bound user is no longer active (403)', async () => {
    const { service, prisma, signedUrl } = build();
    signedUrl.verify.mockReturnValue({ attachmentId: 'a-1', userId: 'pat', exp: 9999999999 });
    prisma.user.findUnique.mockResolvedValue({
      id: 'pat',
      role: Role.PATIENT,
      status: UserStatus.DEACTIVATED,
    });
    await expect(service.resolveDownload('a-1', 'tok')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('404s a download for a missing attachment', async () => {
    const { service, prisma, signedUrl } = build();
    signedUrl.verify.mockReturnValue({ attachmentId: 'a-1', userId: 'pat', exp: 9999999999 });
    prisma.user.findUnique.mockResolvedValue({
      id: 'pat',
      role: Role.PATIENT,
      status: UserStatus.ACTIVE,
    });
    prisma.attachment.findUnique.mockResolvedValue(null);
    await expect(service.resolveDownload('a-1', 'tok')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('streams a download and audits access after re-authorizing', async () => {
    const { service, prisma, signedUrl, storage, audit } = build();
    signedUrl.verify.mockReturnValue({ attachmentId: 'a-1', userId: 'pat', exp: 9999999999 });
    prisma.user.findUnique.mockResolvedValue({
      id: 'pat',
      role: Role.PATIENT,
      status: UserStatus.ACTIVE,
    });
    prisma.attachment.findUnique.mockResolvedValue({
      id: 'a-1',
      consultationId: 'c-1',
      storageKey: 'key',
      mimeType: 'image/png',
      filename: 'f.png',
      sizeBytes: 5,
      consultation: inSession,
    });
    storage.openStream.mockReturnValue({ pipe: jest.fn() });
    const result = await service.resolveDownload('a-1', 'tok');
    expect(result.mimeType).toBe('image/png');
    expect(audit.record).toHaveBeenCalled();
  });
});
