// Runs inside a throwaway container on the stack's network: node scripts/e2e-phase.mjs <apps|requests>
// Needs only Node and the built connectors package. Addresses and key names arrive as JSON in E2E_ADDR.
import { wireApps, wireRequests } from "../packages/connectors/dist/index.js";
import { SELECTED, contextFrom } from "./e2e-context.mjs";

const phase = process.argv[2];
const { internal, keyVars } = JSON.parse(process.env.E2E_ADDR);
const ctx = contextFrom(internal, keyVars, process.env, (m) => console.log(`LOG ${m}`));

if (phase === "apps") await wireApps(ctx, SELECTED);
else if (phase === "requests") await wireRequests(ctx, SELECTED);
else throw new Error(`unknown phase ${phase}`);
