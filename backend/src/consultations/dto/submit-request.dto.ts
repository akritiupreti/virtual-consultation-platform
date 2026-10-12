import { Priority } from '@prisma/client';
import {
  Equals,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Controlled list of symptom categories (requirements intake schema). */
export const SYMPTOM_CATEGORIES = [
  'GENERAL',
  'RESPIRATORY',
  'CARDIAC',
  'GASTROINTESTINAL',
  'MUSCULOSKELETAL',
  'DERMATOLOGY',
  'NEUROLOGICAL',
  'MENTAL_HEALTH',
  'OTHER',
] as const;

/**
 * Patient intake (docs/requirements.md "Intake schema"). Required: chief
 * complaint, symptom category, onset/duration, severity, explicit consent.
 * Optional: priority suggestion, history, medications. Attachments are Phase 4.
 */
export class SubmitRequestDto {
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  chiefComplaint!: string;

  @IsIn(SYMPTOM_CATEGORIES)
  symptomCategory!: (typeof SYMPTOM_CATEGORIES)[number];

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  onsetDuration!: string;

  @IsInt()
  @Min(1)
  @Max(5)
  severity!: number;

  /** Consent to process clinical data must be explicitly granted (true). */
  @IsBoolean()
  @Equals(true)
  consent!: boolean;

  @IsOptional()
  @IsIn([Priority.ROUTINE, Priority.URGENT, Priority.EMERGENCY])
  priority?: Priority;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  history?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  medications?: string;
}
