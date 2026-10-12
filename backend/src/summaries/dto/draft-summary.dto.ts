import { IsString, MaxLength, MinLength } from 'class-validator';

export class DraftSummaryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  content!: string;
}
