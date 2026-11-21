import { Router } from "express";
import { optionalVerifyToken, verifyToken } from "../middlewares/verifyToken.js";
import {
  getLatestTutors,
  getMyProfile,
  getTutorById,
  getUserRole,
  listTutors,
  updateMyProfile,
  upsertUser,
} from "../controllers/user.controller.js";

const router = Router();

/* Users (mounted at /api) */
router.post("/users", optionalVerifyToken, upsertUser);
router.get("/users/me", verifyToken, getMyProfile);
router.patch("/users/profile", verifyToken, updateMyProfile);
router.get("/users/role/:email", verifyToken, getUserRole);

/* Tutors: public directory (static paths BEFORE the :id route) */
router.get("/tutors", listTutors);
router.get("/tutors/latest", getLatestTutors);
router.get("/tutors/:id", getTutorById);

export default router;