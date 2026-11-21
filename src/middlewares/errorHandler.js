/** Wraps an async route handler so rejected promises reach the error middleware. */
export const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

/** 404 for any route that did not match. */
export const notFoundHandler = (req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
};

/** Centralized error handler (must be registered last). */
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  let status = err.status || err.statusCode || 500;
  let message = err.message || "Internal server error";

  if (err.type === "entity.parse.failed") {
    status = 400;
    message = "Invalid JSON in request body";
  } else if (err.type === "entity.too.large") {
    status = 413;
    message = "Request body is too large";
  } else if (err.code === 11000) {
    // MongoDB duplicate key (unique index)
    status = 409;
    message = "This record already exists";
  } else if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
    status = 401;
    message = "Unauthorized: invalid or expired token";
  }

  if (status >= 500) {
    console.error("❌ Server error:", err);
    // Never leak internals to clients in production
    if (process.env.NODE_ENV === "production") message = "Internal server error";
  }

  return res.status(status).json({ message });
};

export default errorHandler;