import type { ErrorRequestHandler, RequestHandler } from 'express';
import { MulterError } from 'multer';
import { ChainNotConfiguredError, ChainUnavailableError } from '../services/chain.service';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const statusCode = res.statusCode >= 400 ? res.statusCode : error?.statusCode ?? 500;
  const isProduction = process.env.NODE_ENV === 'production';

  // Chain outage or missing chain configuration: an expected operational state, answered as a plain 503 with its
  // message and never a stack trace — whatever NODE_ENV says. The request's own rollback has already run.
  if (error instanceof ChainUnavailableError || error instanceof ChainNotConfiguredError) {
    res.status(503).json({ message: error.message });
    return;
  }

  if (error?.code === 11000) {
    res.status(409).json({ message: 'A user with this email already exists' });
    return;
  }

  if (error?.name === 'ValidationError') {
    // One plain sentence per field, the shape the client renders (client/src/lib/api.ts). Mongoose's own messages and
    // error objects quote the submitted value back and name its internals, so neither is sent.
    res.status(400).json({ message: 'Validation failed', errors: describeValidationErrors(error.errors) });
    return;
  }

  // Malformed or oversized JSON bodies (body-parser): the client's mistake, answered plainly and never with a stack.
  if (error?.type === 'entity.parse.failed') {
    res.status(400).json({ message: 'Request body is not valid JSON' });
    return;
  }

  if (error?.type === 'entity.too.large') {
    res.status(413).json({ message: 'Request body is too large' });
    return;
  }

  if (error instanceof MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? 'Uploaded file exceeds the 5 MB limit'
        : 'Document upload failed';

    res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ message });
    return;
  }

  if (error?.message === 'Only PDF, JPG, and PNG files are allowed') {
    res.status(400).json({ message: error.message });
    return;
  }

  // A stack trace helps a developer with a 500 outside production; a 4xx is the client's error and never carries one.
  res.status(statusCode).json({
    message: statusCode === 500 ? 'Internal server error' : error.message,
    stack: isProduction || statusCode < 500 ? undefined : error.stack,
  });
};

const VALIDATION_MESSAGE_BY_KIND: Record<string, (field: string) => string> = {
  required: (field) => `${field} is required`,
  maxlength: (field) => `${field} is too long`,
  minlength: (field) => `${field} is too short`,
  enum: (field) => `${field} is not an allowed value`,
  regexp: (field) => `${field} is not in the expected format`,
};

const describeValidationErrors = (errors: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries((errors ?? {}) as Record<string, { kind?: string }>).map(([field, detail]) => [
      field,
      (VALIDATION_MESSAGE_BY_KIND[detail?.kind ?? ''] ?? ((name: string) => `${name} is invalid`))(field),
    ])
  );
