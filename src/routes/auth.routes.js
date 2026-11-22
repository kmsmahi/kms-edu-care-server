import { Router } from "express";
import { issueJwt } from "../controllers/auth.controller.js";

const router = Router();
router.post(["/jwt", "/auth/jwt"], issueJwt);

export default router;