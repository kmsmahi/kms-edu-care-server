import jwt from "jsonwebtoken";
import { users, connectDB } from "../config/db.js";
import { generateToken } from "../utils/generateToken.js";
import { asyncHandler } from "../middlewares/errorHandler.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeEmail = (value) => String(value ?? "").trim().toLowerCase();

/* ------------------- Firebase ID token verification ------------------- */
// Verifies the token with Google's public keys: no firebase-admin needed.

const GOOGLE_CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

let certCache = { certs: null, expiresAt: 0 };

const getGoogleCerts = async () => {
  if (certCache.certs && Date.now() < certCache.expiresAt) return certCache.certs;

  const response = await fetch(GOOGLE_CERTS_URL);
  if (!response.ok) throw new Error("Could not fetch Firebase public keys");

  const certs = await response.json();
  const maxAge = /max-age=(\d+)/.exec(
    response.headers.get("cache-control") || ""
  )?.[1];
  certCache = {
    certs,
    expiresAt: Date.now() + (maxAge ? Number(maxAge) * 1000 : 60 * 60 * 1000),
  };
  return certs;
};

const verifyFirebaseIdToken = async (idToken, projectId) => {
  const decoded = jwt.decode(idToken, { complete: true });
  const keyId = decoded?.header?.kid;
  if (!keyId) throw new Error("Malformed Firebase token");

  const certs = await getGoogleCerts();
  const certificate = certs[keyId];
  if (!certificate) throw new Error("Unknown Firebase signing key");

  return jwt.verify(idToken, certificate, {
    algorithms: ["RS256"],
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`,
  });
};

let warnedInsecure = false;

/**
 * POST /api/auth/jwt  (also available as POST /api/jwt)
 * Body: { email, idToken? }
 *
 * - With FIREBASE_PROJECT_ID set: a valid Firebase ID token for that email is REQUIRED.
 * - Without it: email-only (development convenience). Do not deploy like this.
 *
 * The token carries { email, role }. A brand-new account that is not in the
 * database yet (registration issues the token first) gets role "student";
 * verifyRole always re-checks the real role in MongoDB anyway.
 */
export const issueJwt = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ message: "A valid email is required" });
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;

  if (projectId) {
    const idToken = req.body?.idToken;
    if (typeof idToken !== "string" || !idToken) {
      return res.status(401).json({ message: "Firebase ID token is required" });
    }

    try {
      const verified = await verifyFirebaseIdToken(idToken, projectId);
      if (normalizeEmail(verified.email) !== email) {
        return res
          .status(401)
          .json({ message: "Token does not match this email" });
      }
    } catch (error) {
      console.warn("Firebase token rejected:", error.message);
      return res
        .status(401)
        .json({ message: "Invalid or expired Firebase ID token" });
    }
  } else if (!warnedInsecure) {
    warnedInsecure = true;
    console.warn(
      "FIREBASE_PROJECT_ID is not set: /auth/jwt issues tokens for ANY email without proof. Set it before deploying."
    );
  }

  if (!users) {
    await connectDB();
  }

  const account = await users.findOne({ email }, { projection: { role: 1 } });
  const role = account?.role || "student";

  const token = generateToken({ email, role });
  return res.json({ token, role });
});