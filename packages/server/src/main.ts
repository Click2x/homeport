import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "@homeport/core";
import { buildApp } from "./app.js";
import { makeSetupCode } from "./crypto.js";
import { realOps } from "./ops.js";
import { Store } from "./store.js";

const inContainer = process.env.HOMEPORT_IN_CONTAINER === "1";
const dataDir = process.env.HOMEPORT_DATA ?? (inContainer ? "/data" : join(process.cwd(), ".homeport-data"));
const host = process.env.HOMEPORT_HOST ?? "0.0.0.0";
const port = Number(process.env.HOMEPORT_PORT ?? 8484);
const here = fileURLToPath(new URL(".", import.meta.url));
const version = (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string })
  .version;

const store = Store.open(dataDir);
const needsSetup = store.userCount() === 0;
const setupToken = needsSetup ? makeSetupCode() : null;

const app = await buildApp({
  store,
  catalog: loadCatalog(),
  ops: realOps,
  dataDir,
  version,
  setupToken,
  webDir: process.env.HOMEPORT_WEB ?? join(here, "..", "..", "web", "dist"),
});

await app.listen({ host, port });

console.log(`\nHomeport ${version} is running on port ${port}.`);
if (needsSetup) {
  console.log("\n  First time here? Open Homeport in your browser and enter this setup code:\n");
  console.log(`      ${setupToken}\n`);
  console.log("  (It is only shown once per start, and only works until you create your account.)\n");
}

const stop = async () => {
  await app.close();
  store.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
