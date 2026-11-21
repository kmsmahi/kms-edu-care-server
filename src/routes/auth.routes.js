import { Router } from "express";
import { issueJwt } from "../controllers/auth.controller.js";

const router = Router();

// Mounted at /api, so both URLs work: /api/auth/jwt and /api/jwt
router.post(["/jwt", "/auth/jwt"], issueJwt);

export default router;