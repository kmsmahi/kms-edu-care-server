import { Router } from "express";
import { verifyToken } from "../middlewares/verifyToken.js";
import { verifyAdmin, verifyRole } from "../middlewares/verifyRole.js";
import {
  changeUserRole,
  deleteUser,
  getDashboardStats,
  getReports,
  listAllTuitions,
  listUsers,
  updateTuitionStatus,
  updateUser,
} from "../controllers/admin.controller.js";

const router = Router();

/* Overview numbers: any logged-in role (the controller returns role-specific stats) */
router.get(
  "/dashboard/stats",
  verifyToken,
  verifyRole("student", "tutor", "admin"),
  getDashboardStats
);

/* Everything under /admin requires a logged-in admin (role re-checked in MongoDB) */
router.use("/admin", verifyToken, verifyAdmin);

router.get("/admin/users", listUsers);
router.patch("/admin/users/:id/role", changeUserRole);
router.patch("/admin/users/:id", updateUser);
router.delete("/admin/users/:id", deleteUser);

router.get("/admin/tuitions", listAllTuitions);
router.patch("/admin/tuitions/:id/status", updateTuitionStatus);

router.get("/admin/reports", getReports);

export default router;