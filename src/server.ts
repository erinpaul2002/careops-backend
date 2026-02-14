import "dotenv/config";
import express from "express";
import cors from "cors";
import { createApiRouter } from "./routes";
import { createHealthRoutes } from "./routes/healthRoutes";
import { createGoogleAuthRoutes } from "./routes/googleAuthRoutes";
import { startWorker } from "./utils/worker";
import { connectDatabase, isDatabaseConfigured } from "./database/connection";
import { hydrateStateFromDatabase } from "./database/persistence";
import { state } from "./utils/store";

const app = express();
const port = Number(process.env.PORT ?? 8000);

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/", createHealthRoutes());
app.use("/auth", createGoogleAuthRoutes());
app.use("/api/v1", createApiRouter());

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

async function bootstrap(): Promise<void> {
  if (isDatabaseConfigured()) {
    try {
      await connectDatabase();

      await hydrateStateFromDatabase(state);
      console.log("MongoDB connected and state hydrated");
    } catch (error) {
      console.error("MongoDB initialization failed, using in-memory mode", error);
    }
  } else {
    console.warn("DATABASE_URL/MONGODB_URI not set, using in-memory mode");
  }

  startWorker();
  app.listen(port, () => {
    console.log(`CareOps backend listening on port ${port}`);
  });
}

void bootstrap();
