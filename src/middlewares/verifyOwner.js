import { users, connectDB } from "../config/db.js";

const normalizeEmail = (value) => String(value ?? "").trim().toLowerCase();

export const getOwnerEmail = () => normalizeEmail(process.env.OWNER_EMAIL);

export const isOwnerEmail = (email) => {
  const ownerEmail = getOwnerEmail();
  return Boolean(ownerEmail) && normalizeEmail(email) === ownerEmail;
};

/**
 * Must run AFTER verifyToken.
 * Allows only the configured OWNER_EMAIL (and requires their DB role to be "admin").
 */
export const verifyOwner = async (req, res, next) => {
  try {
    const requesterEmail = normalizeEmail(req.user?.email);
    if (!requesterEmail) {
      return res.status(401).json({ message: "Unauthorized: please log in" });
    }

    if (!isOwnerEmail(requesterEmail)) {
      return res.status(403).json({
        message: "Forbidden: only the system owner can manage admin roles",
      });
    }

    if (!users) {
      await connectDB();
    }

    const account = await users.findOne(
      { email: requesterEmail },
      { projection: { role: 1 } }
    );

    if (!account || account.role !== "admin") {
      return res.status(403).json({
        message: "Forbidden: owner account must have admin role in database",
      });
    }

    req.user.email = requesterEmail;
    req.user.role = account.role;
    req.user.isOwner = true;
    return next();
  } catch (error) {
    return next(error);
  }
};

export default verifyOwner;