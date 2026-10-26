import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * A minimal local-filesystem object store for attachments (ADR-0007). We chose a
 * local store with app-issued signed URLs over S3/MinIO presigned URLs precisely
 * because our access rule is *participant-only, never admin, state-aware* — every
 * download must pass through the app's authorization pipeline, which a bucket's
 * own presigned URL cannot express. Files are written under a configured directory
 * (git-ignored, outside any served path) and named by an opaque random key, never
 * the client filename, so a traversal or collision is impossible.
 */
@Injectable()
export class AttachmentStorageService {
  private readonly log = new Logger(AttachmentStorageService.name);
  private readonly baseDir: string;

  constructor(config: ConfigService) {
    const configured = config.get<string>('ATTACHMENT_STORAGE_DIR') ?? './var/attachments';
    // Resolve relative to the backend workspace cwd so it is deterministic.
    this.baseDir = isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }

  /** Persist bytes under a fresh opaque key and return that key. */
  async save(buffer: Buffer): Promise<string> {
    await mkdir(this.baseDir, { recursive: true });
    const storageKey = randomUUID();
    await writeFile(this.pathFor(storageKey), buffer, { flag: 'wx' });
    return storageKey;
  }

  /**
   * Delete a stored object. Best-effort: a file that is already gone is fine, and
   * any other failure is logged rather than thrown — the database row (the record
   * of the file) has already been removed, which is what makes it unreachable.
   */
  async remove(storageKey: string): Promise<void> {
    try {
      await unlink(this.pathFor(storageKey));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn(`Could not delete stored attachment object: ${(err as Error).message}`);
      }
    }
  }

  /** Open a read stream for a stored object by its key. */
  openStream(storageKey: string): ReadStream {
    return createReadStream(this.pathFor(storageKey));
  }

  /**
   * Resolve a storage key to an absolute path, guarding against path traversal:
   * the resolved path must stay within the base directory.
   */
  private pathFor(storageKey: string): string {
    const full = resolve(this.baseDir, storageKey);
    const root = resolve(this.baseDir);
    if (full !== join(root, storageKey) || !full.startsWith(root)) {
      // storageKey is always a server-generated UUID, so this is defence in depth.
      this.log.error(`Rejected suspicious storage key: ${storageKey}`);
      throw new Error('Invalid storage key');
    }
    return full;
  }
}
