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
    attachment: {
      count: jest.fn(),
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    user: { findUnique: jest.fn() },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const storage = { save: jest.fn(), openStream: jest.fn(), remove: jest.fn() };
  const signedUrl = { verify: jest.fn(), sign: jest.fn(), ttl: 300 };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const realtime = { notifyAttachmentCreated: jest.fn(), notifyAttachmentRemoved: jest.fn() };
  const service = new AttachmentsService(
    prisma as never,
    audit as never,
    storage as never,
    signedUrl as never,
    config as never,
    realtime as never,
  );
  return { service, prisma, audit, storage, signedUrl, realtime };
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

  it('stores a valid upload, audits it, and signals the room (no filename in the signal)', async () => {
    const { service, prisma, storage, audit, realtime } = build();
    prisma.consultation.findUnique.mockResolvedValue(inSession);
    prisma.attachment.count.mockResolvedValue(0);
    storage.save.mockResolvedValue('opaque-key');
    prisma.attachment.create.mockResolvedValue({
      id: 'a-1',
      filename: 'rash.png',
      mimeType: 'image/png',
      sizeBytes: 12,
      uploadedBy: 'pat',
      createdAt: new Date(),
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const view = await service.upload(participant, 'c-1', {
      buffer: png,
      originalname: 'rash.png',
      mimetype: 'image/png',
      size: 12,
    });
    expect(view.id).toBe('a-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ATTACHMENT_UPLOADED' }),
    );
    expect(realtime.notifyAttachmentCreated).toHaveBeenCalledWith('c-1');
  });

  describe('remove (ADR-0028)', () => {
    const own = {
      id: 'a-1',
      consultationId: 'c-1',
      uploadedBy: 'pat',
      mimeType: 'image/png',
      sizeBytes: 12,
      storageKey: 'key-1',
    };

    it('lets the patient remove their own file during the session, then audits and signals', async () => {
      const { service, prisma, storage, audit, realtime } = build();
      prisma.consultation.findUnique.mockResolvedValue(inSession);
      prisma.attachment.findUnique.mockResolvedValue(own);
      prisma.attachment.deleteMany.mockResolvedValue({ count: 1 });
      await service.remove(participant, 'c-1', 'a-1');
      // The delete re-checks IN_SESSION in the database (race-safe).
      expect(prisma.attachment.deleteMany).toHaveBeenCalledWith({
        where: { id: 'a-1', consultationId: 'c-1', consultation: { state: 'IN_SESSION' } },
      });
      expect(storage.remove).toHaveBeenCalledWith('key-1');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'ATTACHMENT_DELETED',
          metadata: { attachmentId: 'a-1', mimeType: 'image/png', sizeBytes: 12 },
        }),
      );
      expect(realtime.notifyAttachmentRemoved).toHaveBeenCalledWith('c-1');
    });

    it('refuses once the session has ended (409) and keeps the file', async () => {
      const { service, prisma, storage } = build();
      prisma.consultation.findUnique.mockResolvedValue(inSession);
      prisma.attachment.findUnique.mockResolvedValue(own);
      prisma.attachment.deleteMany.mockResolvedValue({ count: 0 }); // state moved on
      await expect(service.remove(participant, 'c-1', 'a-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(storage.remove).not.toHaveBeenCalled();
    });

    it("refuses a file the patient did not upload (a clinician's) — 403", async () => {
      const { service, prisma } = build();
      prisma.consultation.findUnique.mockResolvedValue(inSession);
      prisma.attachment.findUnique.mockResolvedValue({ ...own, uploadedBy: 'doc' });
      await expect(service.remove(participant, 'c-1', 'a-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.attachment.deleteMany).not.toHaveBeenCalled();
    });

    it('denies clinicians by role, even their own uploads (matrix)', async () => {
      const { service, prisma } = build();
      prisma.consultation.findUnique.mockResolvedValue(inSession);
      await expect(
        service.remove({ id: 'doc', role: Role.DOCTOR }, 'c-1', 'a-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s a file from another consultation', async () => {
      const { service, prisma } = build();
      prisma.consultation.findUnique.mockResolvedValue(inSession);
      prisma.attachment.findUnique.mockResolvedValue({ ...own, consultationId: 'c-other' });
      await expect(service.remove(participant, 'c-1', 'a-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
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
