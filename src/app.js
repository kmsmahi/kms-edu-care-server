import express from "express";
import cors from "cors";
import { connectDB } from "./config/db.js";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler.js";

import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import tuitionRoutes from "./routes/tuition.routes.js";
import applicationRoutes from "./routes/application.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import adminRoutes from "./routes/admin.routes.js";

const app = express();
app.disable("x-powered-by");

/* ------------------------------- CORS ------------------------------- */
// CLIENT_URL (comma-separated for several) + the local Vite dev origin
const normalizeOrigin = (origin) => String(origin).trim().replace(/\/+$/, "");

const allowedOrigins = [
  ...(process.env.CLIENT_URL || "").split(","),
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]
  .map(normalizeOrigin)
  .filter(Boolean);

app.use(
  cors({
    // No Origin header (curl, Postman, server-to-server) is allowed; browsers must match the list
    origin: (origin, callback) =>
      callback(null, !origin || allowedOrigins.includes(normalizeOrigin(origin))),
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);

app.use(express.json({ limit: "500kb" }));

/* Liveness check: responds even before the database is reachable */
app.get("/", (req, res) => {
  res.json({ name: "KMS EduCare API", status: "running" });
});

/* ------------- Database (cached connection, serverless-safe) ------------- */
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    next(error);
  }
});

/* ------------------------------ API ------------------------------ */
app.use("/api", (req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  next();
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.use("/api", authRoutes);
app.use("/api", userRoutes);
app.use("/api", tuitionRoutes);
app.use("/api", applicationRoutes);
app.use("/api", paymentRoutes);
app.use("/api", adminRoutes);

/* --------------------------- Error handling --------------------------- */
app.use(notFoundHandler);
app.use(errorHandler);

export default app;