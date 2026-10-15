import { UnsupportedMediaTypeException } from '@nestjs/common';

/**
 * Allowed attachment types (C4 / FR-5): a small, fixed set. The key is the
 * canonical MIME type we store; `magic` is the file's leading signature bytes, so
 * we validate the real content and never trust the client-declared Content-Type.
 */
interface AllowedType {
  mime: string;
  extensions: string[];
  /** One or more acceptable leading-byte signatures. */
  magic: number[][];
}

const ALLOWED_TYPES: AllowedType[] = [
  { mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'], magic: [[0xff, 0xd8, 0xff]] },
  {
    mime: 'image/png',
    extensions: ['.png'],
    magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  },
  { mime: 'application/pdf', extensions: ['.pdf'], magic: [[0x25, 0x50, 0x44, 0x46, 0x2d]] },
];

export const ALLOWED_MIME_TYPES: string[] = ALLOWED_TYPES.map((t) => t.mime);

function matchesMagic(buffer: Buffer, signature: number[]): boolean {
  if (buffer.length < signature.length) {
    return false;
  }
  return signature.every((byte, i) => buffer[i] === byte);
}

/**
 * Validate an uploaded file's real type by sniffing its magic bytes and confirming
 * the declared MIME type agrees. Returns the canonical MIME type to persist, or
 * throws 415 if the content is not a permitted JPEG/PNG/PDF. The client-supplied
 * `declaredMime` must also be in the allow-list, so a mismatched or spoofed
 * Content-Type is rejected even when the bytes happen to be valid.
 */
export function resolveAttachmentMime(buffer: Buffer, declaredMime: string): string {
  const byContent = ALLOWED_TYPES.find((t) => t.magic.some((sig) => matchesMagic(buffer, sig)));
  if (!byContent) {
    throw new UnsupportedMediaTypeException('File type not allowed — only JPEG, PNG, or PDF');
  }
  if (declaredMime !== byContent.mime) {
    // The bytes are a valid allowed type, but the declared type disagrees: reject
    // rather than silently trusting one over the other.
    throw new UnsupportedMediaTypeException('Declared content type does not match file content');
  }
  return byContent.mime;
}
