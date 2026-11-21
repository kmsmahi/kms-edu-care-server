import { Router } from "express";
import { verifyToken } from "../middlewares/verifyToken.js";
import { verifyStudent, verifyTutor } from "../middlewares/verifyRole.js";
import {
  confirmPayment,
  createPaymentIntent,
  getStudentPayments,
  getTutorPayments,
} from "../controllers/payment.controller.js";

const router = Router();

/* Student: pay for an accepted tutor */
router.post("/payments/create-intent", verifyToken, verifyStudent, createPaymentIntent);
router.post("/payments/confirm", verifyToken, verifyStudent, confirmPayment);
router.get("/payments/student", verifyToken, verifyStudent, getStudentPayments);

/* Tutor: revenue history */
router.get("/payments/tutor", verifyToken, verifyTutor, getTutorPayments);

export default router;