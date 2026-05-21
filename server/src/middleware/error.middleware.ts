import type { ErrorRequestHandler, RequestHandler } from 'express';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const statusCode = res.statusCode >= 400 ? res.statusCode : 500;
  const isProduction = process.env.NODE_ENV === 'production';

  if (error?.code === 11000) {
    res.status(409).json({ message: 'A user with this email already exists' });
    return;
  }

  if (error?.name === 'ValidationError') {
    res.status(400).json({ message: 'Validation failed', errors: error.errors });
    return;
  }

  res.status(statusCode).json({
    message: statusCode === 500 ? 'Internal server error' : error.message,
    stack: isProduction ? undefined : error.stack,
  });
};
