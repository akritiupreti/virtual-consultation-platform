import { Controller, Get } from '@nestjs/common';

interface HealthResponse {
  status: 'ok';
  timestamp: string;
}

@Controller()
export class AppController {
  /** Unauthenticated liveness probe (expanded into readiness checks in Phase 5). */
  @Get('health')
  health(): HealthResponse {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
