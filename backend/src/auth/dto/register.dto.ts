import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Self-registration creates a PATIENT only. Staff accounts (NURSE/DOCTOR/ADMIN)
 * are provisioned via seed or by an admin (Phase 2+) — this prevents privilege
 * escalation at the public registration endpoint (NFR-1).
 */
export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
