import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Filters for the admin audit query (FR-15). Every field is optional; unknown
 * fields are rejected by the global ValidationPipe. No clinical content is ever a
 * filter or a result — the audit log holds who/what/when only.
 */
export class AuditQueryDto {
  /** Filter to a single actor (the user who performed the action). */
  @IsOptional()
  @IsUUID()
  actorId?: string;

  /** Filter to a single event type (e.g. CONSULTATION_CLAIMED). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  eventType?: string;

  /** Filter to a single consultation's trail. */
  @IsOptional()
  @IsUUID()
  consultationId?: string;

  /** Inclusive lower bound on event time (ISO 8601). */
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** Inclusive upper bound on event time (ISO 8601). */
  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
