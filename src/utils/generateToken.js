import jwt from "jsonwebtoken";

/**
 * Signs a JWT carrying { email, role }.
 * Expiry defaults to 7 days and can be overridden with JWT_EXPIRES_IN.
 */
export const generateToken = ({ email, role }) => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error("JWT_SECRET is not defined in the environment variables");
  }

  return jwt.sign({ email, role }, secret, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
};

export default generateToken;