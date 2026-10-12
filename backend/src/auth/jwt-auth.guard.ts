import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Requires a valid JWT. Role + state authorization guards arrive in Phase 2. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
