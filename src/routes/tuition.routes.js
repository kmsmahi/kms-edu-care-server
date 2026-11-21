import { Router } from "express";
import { optionalVerifyToken, verifyToken } from "../middlewares/verifyToken.js";
import { verifyStudent } from "../middlewares/verifyRole.js";
import {
  createTuition,
  deleteTuition,
  getFilterOptions,
  getLatestTuitions,
  getMyTuitions,
  getTuitionById,
  listTuitions,
  updateTuition,
} from "../controllers/tuition.controller.js";

const router = Router();

/* Public catalog (static paths MUST come before "/tuitions/:id") */
router.get("/tuitions", listTuitions);
router.get("/tuitions/latest", getLatestTuitions);
router.get("/tuitions/filter-options", getFilterOptions);

/* Student-only */
router.get("/tuitions/my", verifyToken, verifyStudent, getMyTuitions);
router.post("/tuitions", verifyToken, verifyStudent, createTuition);

/* Details: public, but the optional token lets owners/admins see non-approved posts */
router.get("/tuitions/:id", optionalVerifyToken, getTuitionById);

router.patch("/tuitions/:id", verifyToken, verifyStudent, updateTuition);
router.delete("/tuitions/:id", verifyToken, verifyStudent, deleteTuition);

export default router;