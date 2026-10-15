import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Response } from 'express';

/** The subset of multer's error shape we care about. */
interface MulterLikeError extends Error {
  code?: string;
}

/**
 * Maps multer upload errors to the API's consistent error model (docs/api-spec.md):
 * an over-size file → 413, anything else malformed about the multipart upload → 400.
 * Without this, a raw multer error would surface as an opaque 500.
 */
@Catch()
export class MulterExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const err = exception as MulterLikeError;

    if (err?.name === 'MulterError') {
      const mapped =
        err.code === 'LIMIT_FILE_SIZE'
          ? new PayloadTooLargeException('File exceeds the size limit')
          : new BadRequestException('Invalid file upload');
      const status = mapped.getStatus();
      response.status(status).json(mapped.getResponse());
      return;
    }

    // Re-raise anything that is already an HttpException with its own status.
    const anyErr = exception as { getStatus?: () => number; getResponse?: () => unknown };
    if (typeof anyErr?.getStatus === 'function' && typeof anyErr?.getResponse === 'function') {
      response.status(anyErr.getStatus()).json(anyErr.getResponse());
      return;
    }

    response.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }
}
