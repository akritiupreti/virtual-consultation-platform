import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Mints and verifies short-lived, user-scoped signed URLs for attachment download
 * (C4 / NFR-2 / ADR-0007). A token is an opaque HMAC over `{attachmentId, userId,
 * exp}` — it carries NO filename, patient id, or clinical data, so nothing
 * sensitive ever lands in a URL/query string (invariant 6). The token binds the
 * download to the exact user who requested it; the download handler still re-runs
 * the full authorization check (role → state → ownership) and the active-account
 * check, so a signed URL never bypasses the matrix (admins remain denied).
 */
export interface SignedUrlClaims {
  attachmentId: string;
  userId: string;
  /** Unix epoch seconds when the token expires. */
  exp: number;
}

@Injectable()
export class SignedUrlService {
  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(config: ConfigService) {
    // Reuse a dedicated secret if provided; otherwise fall back to JWT_SECRET so
    // local dev works out of the box. Any non-local deployment must set a strong,
    // separate value (documented in .env.example).
    this.secret =
      config.get<string>('ATTACHMENT_URL_SECRET') ?? config.get<string>('JWT_SECRET') ?? '';
    if (!this.secret) {
      throw new Error('ATTACHMENT_URL_SECRET (or JWT_SECRET) must be set — see .env.example');
    }
    const ttl = Number(config.get('ATTACHMENT_URL_TTL_SECONDS'));
    this.ttlSeconds = Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 300;
  }

  /** How long a freshly-minted token is valid, in seconds. */
  get ttl(): number {
    return this.ttlSeconds;
  }

  /** Mint a signed token binding this attachment to this user for a short window. */
  sign(attachmentId: string, userId: string): { token: string; expiresAt: Date } {
    const exp = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    const claims: SignedUrlClaims = { attachmentId, userId, exp };
    const payload = base64url(JSON.stringify(claims));
    const token = `${payload}.${this.hmac(payload)}`;
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /**
   * Verify a token's signature and expiry. Returns the claims on success, or null
   * if the token is malformed, tampered with, or expired. Signature comparison is
   * constant-time.
   */
  verify(token: string): SignedUrlClaims | null {
    if (typeof token !== 'string' || !token.includes('.')) {
      return null;
    }
    const [payload, signature] = token.split('.', 2);
    if (!payload || !signature) {
      return null;
    }
    const expected = this.hmac(payload);
    if (!safeEqual(signature, expected)) {
      return null;
    }
    let claims: SignedUrlClaims;
    try {
      claims = JSON.parse(fromBase64url(payload)) as SignedUrlClaims;
    } catch {
      return null;
    }
    if (!claims.attachmentId || !claims.userId || typeof claims.exp !== 'number') {
      return null;
    }
    if (claims.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return claims;
  }

  private hmac(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function fromBase64url(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}
