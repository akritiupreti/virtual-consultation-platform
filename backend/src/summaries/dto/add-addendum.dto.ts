import { IsString, MaxLength, MinLength } from 'class-validator';

/** An append-only correction to a finalized summary (FR-13, C5). */
export class AddAddendumDto {
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  content!: string;
}
