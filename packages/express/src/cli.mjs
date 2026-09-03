#!/usr/bin/env node
/**
 * bin: stellarsight-seller — offline pre-flight checks for a @stellarsight/express paywall.
 *
 *   npx stellarsight-seller check
 *   npx stellarsight-seller check --json
 *   npx stellarsight-seller check --config ./stellarsight.config.mjs
 *
 * `check` builds the exact records `pay.announce()` would POST to the bazaar index
 * (`announceRecordFor`, route.mjs) and runs them through the index's OWN integrity
 * validator (`@stellarsight/index`'s `createCatalog().upsert()`, see check.mjs) — no
 * facilitator or index has to be running, and nothing is sent over the network. A seller
 * can gate their own CI on the exit code: 1 on any rejection, 0 otherwise.
 *
 * CONFIG FILE CONTRACT. `stellarsight.config.mjs` (resolved from the current working
 * directory, or --config) must export the object `stellarsightPaywall()` returns, with
 * every route already declared via `pay(...)`, as its default export or a named `pay`
 * export. That object is exactly what a real server would import to attach handlers, so
 * the config a seller checks is the config they run — see the express README's CLI
 * section for the full pattern.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const C = process.stdout.isTTY
  ? { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", bold: "\x1b[1m", off: "\x1b[0m" }
  : { dim: "", red: "", green: "", yellow: "", bold: "", off: "" };

const DEFAULT_CONFIG_NAMES = ["stellarsight.config.mjs", "stellarsight.config.js"];

function usage() {
  console.log(`
${C.bold}stellarsight-seller${C.off} — offline pre-flight checks for a @stellarsight/express paywall

  ${C.dim}npx${C.off} stellarsight-seller check [options]

  Validates every declared route's announce record against the bazaar index's own
  integrity rules, locally. No facilitator or index needs to be running.

  --config <path>   path to the config module (default: ./stellarsight.config.{mjs,js})
  --json            print one JSON report instead of one line per route
  -h, --help        show this message

  The config module must export the object returned by stellarsightPaywall(), with
  every route already declared via pay(...), as its default export (or a named "pay"
  export).
`);
}

function parseArgs(argv) {
  const args = { command: null, config: null, json: false, help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--config") args.config = argv[++i];
    else if (a === "-h" || a === "--help") args.help = true;
    else rest.push(a);
  }
  args.command = rest[0] ?? null;
  return args;
}

/** The default config file, or an explicit --config path. Never guesses silently. */
function resolveConfigPath(explicit) {
  if (explicit) {
    const abs = path.resolve(process.cwd(), explicit);
    if (!existsSync(abs)) {
      throw new Error(`--config ${explicit} does not exist (resolved to ${abs}).`);
    }
    return abs;
  }
  for (const name of DEFAULT_CONFIG_NAMES) {
    const abs = path.resolve(process.cwd(), name);
    if (existsSync(abs)) return abs;
  }
  throw new Error(
    `no ${DEFAULT_CONFIG_NAMES.join(" or ")} found in ${process.cwd()}. ` +
      "Pass --config <path>, or create one that exports the object returned by " +
      "stellarsightPaywall(), with every route declared via pay(...).",
  );
}

async function loadPay(configPath) {
  const mod = await import(pathToFileURL(configPath).href);
  const pay = typeof mod.default === "function" ? mod.default : mod.pay;
  if (typeof pay !== "function" || typeof pay.check !== "function") {
    throw new Error(
      `${configPath} must export the object returned by stellarsightPaywall() ` +
        "(as `export default pay` or `export const pay = ...`), not " +
        `${describe(pay)}.`,
    );
  }
  return pay;
}

function describe(value) {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  return `a ${typeof value}`;
}

function printReport(report, { json }) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (report.baseUrlMissing) {
    console.log(`${C.red}FAIL${C.off}  ${report.reason}`);
    return;
  }

  for (const r of report.results) {
    const label = `${r.method.padEnd(6)} ${r.path ?? "(no path)"}`;
    if (r.ok && r.dropped.length === 0) {
      console.log(`${C.green}ok${C.off}    ${label}`);
    } else if (r.ok) {
      console.log(`${C.green}ok${C.off}    ${label}  ${C.yellow}index would drop: ${r.dropped.join(", ")}${C.off}`);
    } else {
      console.log(`${C.red}FAIL${C.off}  ${label}  ${r.reason}`);
    }
  }

  const total = report.results.length;
  const failed = report.results.filter((r) => !r.ok).length;
  if (total === 0) {
    console.log(`${C.yellow}no routes to check${C.off}`);
  } else if (failed === 0) {
    console.log(`\n${C.green}${C.bold}${total}/${total} route(s) ok${C.off}`);
  } else {
    console.log(`\n${C.red}${C.bold}${total - failed}/${total} route(s) ok, ${failed} rejected${C.off}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.command) {
    usage();
    process.exit(args.help ? 0 : 1);
    return;
  }

  if (args.command !== "check") {
    usage();
    console.error(`${C.red}unknown command "${args.command}"${C.off}`);
    process.exit(1);
    return;
  }

  let pay;
  try {
    const configPath = resolveConfigPath(args.config);
    pay = await loadPay(configPath);
  } catch (e) {
    console.error(`${C.red}${e.message}${C.off}`);
    process.exit(1);
    return;
  }

  let report;
  try {
    report = pay.check();
  } finally {
    // Declaring routes arms unref()d announce timers (see announce.mjs); this process
    // never runs long enough for them to fire, but a config module imported elsewhere
    // (e.g. by the caller's own test suite) should not leave them armed either.
    pay.stop?.();
  }

  printReport(report, { json: args.json });
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`${C.red}stellarsight-seller failed unexpectedly:${C.off} ${e?.stack ?? e}`);
  process.exit(1);
});
