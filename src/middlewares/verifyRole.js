import { users, connectDB } from "../config/db.js";

/**
 * Flexible role guard: verifyRole("admin"), verifyRole("student", "tutor"), ...
 * Must run AFTER verifyToken.
 *
 * The role is re-read from MongoDB on every request, so when an admin
 * changes someone's role (or deletes the account) it applies immediately
 * instead of waiting for the old token to expire.
 */
export const verifyRole =
  (...allowedRoles) =>
  async (req, res, next) => {
    try {
      if (!req.user?.email) {
        return res.status(401).json({ message: "Unauthorized: please log in" });
      }

      if (!users) {
        await connectDB();
      }

      const account = await users.findOne(
        { email: req.user.email },
        { projection: { role: 1 } }
      );

      if (!account) {
        return res.status(403).json({ message: "Forbidden: account not found" });
      }

      if (!allowedRoles.includes(account.role)) {
        return res.status(403).json({
          message: "Forbidden: you do not have permission for this action",
        });
      }

      req.user.role = account.role; // trusted, DB-backed role
      return next();
    } catch (error) {
      return next(error);
    }
  };

export const verifyAdmin = verifyRole("admin");
export const verifyTutor = verifyRole("tutor");
export const verifyStudent = verifyRole("student");

export default verifyRole;