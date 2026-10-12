import { Priority } from '@prisma/client';
import { IsIn } from 'class-validator';

/** Triage re-prioritization by a clinician (FR-20). */
export class SetPriorityDto {
  @IsIn([Priority.ROUTINE, Priority.URGENT, Priority.EMERGENCY])
  priority!: Priority;
}
