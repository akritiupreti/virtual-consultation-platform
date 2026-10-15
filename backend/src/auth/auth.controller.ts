import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { AuthThrottle } from '../common/throttler/throttler.config';
import { AuthResult, AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthenticatedUser } from './jwt.strategy';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @AuthThrottle()
  register(@Body() dto: RegisterDto): Promise<AuthResult> {
    return this.auth.register(dto);
  }

  @Post('login')
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<AuthResult> {
    return this.auth.login(dto);
  }

  /** Trivial authenticated endpoint — proves the JWT round-trip works (Phase 1 exit criterion). */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}
