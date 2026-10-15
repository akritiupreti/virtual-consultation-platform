import { Controller, Get } from '@nestjs/common';

interface HealthResponse {
  status: 'ok';
  timestamp: string;
}

@Controller()
export class AppController {
  /**
   * Unauthenticated liveness probe: the process is up and the event loop responds.
   * It intentionally checks no dependencies — the dependency-aware readiness probe
   * is `GET /ready` (HealthController, Phase 5).
   */
  @Get('health')
  health(): HealthResponse {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
