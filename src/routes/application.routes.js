import { Router } from "express";
import { verifyToken } from "../middlewares/verifyToken.js";
import { verifyRole, verifyStudent, verifyTutor } from "../middlewares/verifyRole.js";
import {
  applyToTuition,
  deleteApplication,
  getApplicationById,
  listOngoingTuitions,
  listStudentApplications,
  listTutorApplications,
  rejectApplication,
  updateApplication,
} from "../controllers/application.controller.js";

const router = Router();

/* Tutor */
router.post("/applications", verifyToken, verifyTutor, applyToTuition);
router.get("/applications/tutor", verifyToken, verifyTutor, listTutorApplications);
router.get("/tutor/ongoing-tuitions", verifyToken, verifyTutor, listOngoingTuitions);

/* Student (static paths BEFORE "/applications/:id") */
router.get("/applications/student", verifyToken, verifyStudent, listStudentApplications);

/* Single application: student owner or tutor owner */
router.get("/applications/:id", verifyToken, verifyRole("student", "tutor"), getApplicationById);

router.patch("/applications/:id/reject", verifyToken, verifyStudent, rejectApplication);
router.patch("/applications/:id", verifyToken, verifyTutor, updateApplication);
router.delete("/applications/:id", verifyToken, verifyTutor, deleteApplication);

export default router;