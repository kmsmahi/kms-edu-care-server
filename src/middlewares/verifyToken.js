import jwt from "jsonwebtoken";

/** Reads "Authorization: Bearer <token>" and returns the token (or null). */
const getBearerToken = (req) => {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;

  const [scheme, token] = header.split(" ");
  return scheme === "Bearer" && token ? token : null;
};

/**
 * Requires a valid access token.
 * On success sets req.user = { email, role } (role is refreshed from the DB by verifyRole).
 * Responds 401 when the token is missing, invalid, or expired.
 */
export const verifyToken = (req, res, next) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    const error = new Error("JWT_SECRET is not configured on the server");
    error.status = 500;
    return next(error);
  }

  const token = getBearerToken(req);
  if (!token) {
    return res
      .status(401)
      .json({ message: "Unauthorized: access token missing" });
  }

  try {
    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (!decoded?.email) throw new Error("Malformed token payload");

    req.user = {
      email: String(decoded.email).trim().toLowerCase(),
      role: decoded.role,
    };
    return next();
  } catch (error) {
    const message =
      error.name === "TokenExpiredError"
        ? "Unauthorized: access token expired"
        : "Unauthorized: invalid access token";
    return res.status(401).json({ message });
  }
};

/**
 * Like verifyToken, but lets requests without a token through.
 * A token that IS present must still be valid.
 */
export const optionalVerifyToken = (req, res, next) =>
  getBearerToken(req) ? verifyToken(req, res, next) : next();

export default verifyToken;