import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

const env = loadEnv();
const app = buildApp({ nodeEnv: env.nodeEnv });

async function start(): Promise<void> {
  try {
    await app.listen({ port: env.port, host: env.host });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info(`Received ${signal}, shutting down gracefully`);
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error(error, "Error during shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

void start();
