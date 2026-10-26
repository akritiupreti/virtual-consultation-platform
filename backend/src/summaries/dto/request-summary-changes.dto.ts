import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * A reviewing doctor returns a drafted summary to the drafter to revise (ADR-0024).
 * The note is an optional, short piece of feedback for the drafting clinician. It is
 * delivered to that clinician in real time and is deliberately NOT persisted or
 * audited — only the fact that changes were requested is recorded (invariant 6).
 */
export class RequestSummaryChangesDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note?: string;
}
