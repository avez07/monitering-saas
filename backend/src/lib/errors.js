export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function assert(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}
export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error.name === 'ZodError')
    return res
      .status(400)
      .json({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  const status = error.status || (error.code === 'P2002' ? 409 : 500);
  if (status >= 500) console.error(`[${req.method} ${req.path}]`, error.message);
  res.status(status).json({
    error:
      status >= 500 && !(error instanceof HttpError)
        ? 'The service could not complete this request.'
        : error.message,
  });
}
