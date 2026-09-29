import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
for (const envFile of ["chain/.env.local", "server/.env.local"]) {
  const path = resolve(projectRoot, envFile);
  if (existsSync(path)) process.loadEnvFile(path);
}

if (!process.env.KILN_API_KEY) {
  const localKeyFile = resolve(projectRoot, "Kiln_API");
  if (existsSync(localKeyFile)) {
    process.env.KILN_API_KEY = readFileSync(localKeyFile, "utf8").split(/\r?\n/, 1)[0].trim();
  }
}

const { app } = await import("./app.js");

const configuredPort = Number(process.env.PORT);
const port = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 8787;

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  process.stdout.write(`IntentBound API listening on http://localhost:${info.port}\n`);
});
