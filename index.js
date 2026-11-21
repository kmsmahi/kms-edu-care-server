import "dotenv/config"; // must stay the FIRST import: other modules read process.env on load
import app from "./src/app.js";
import { closeDB, connectDB } from "./src/config/db.js";

const PORT = process.env.PORT || 5000;

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

/**
 * On Vercel the platform calls the exported app per request (no listen()).
 * Everywhere else (local, VPS, Render...) start a normal HTTP server.
 */
if (!process.env.VERCEL) {
  const missing = ["MONGODB_URI", "JWT_SECRET"].filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  connectDB()
    .then(() => {
      const server = app.listen(PORT, () => {
        console.log(`KMS EduCare API running on http://localhost:${PORT}`);
      });

      const shutdown = (signal) => {
        console.log(`\n${signal} received: shutting down...`);
        server.close(async () => {
          await closeDB();
          process.exit(0);
        });
      };

      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    })
    .catch((error) => {
      console.error("Failed to start the server:", error.message);
      process.exit(1);
    });
}

export default app;