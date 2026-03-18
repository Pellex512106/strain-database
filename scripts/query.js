#!/usr/bin/env node
/**
 * scripts/query.js  —  schema v2.0
 *
 * Filter and display strains from data.json via CLI flags.
 *
 * Usage:
 *   node scripts/query.js [options]
 *
 * Options:
 *   --effect  <value>   Filter by effect          (e.g. --effect relaxed)
 *   --flavor  <value>   Filter by flavor           (e.g. --flavor earthy)
 *   --tag     <value>   Filter by tag              (e.g. --tag award-winner)
 *   --type    <value>   Filter by genetics type    (e.g. --type Indica)
 *   --difficulty <val>  Filter by difficulty       (Easy | Moderate | Hard)
 *   --status  <value>   Filter by status           (complete | stub)
 *   --thc-min <num>     Min THC (avg) threshold    (e.g. --thc-min 20)
 *   --thc-max <num>     Max THC (avg) threshold    (e.g. --thc-max 25)
 *   --cbd-min <num>     Min CBD lower bound
 *   --cbd-max <num>     Max CBD upper bound
 *   --id      <slug>    Exact ID match
 *   --json              Output raw JSON array instead of table
 *   --fields  <f,f,..>  Comma-separated fields to display (table mode)
 *
 * Multiple filters are ANDed together.
 * String filters are case-insensitive.
 *
 * Examples:
 *   node scripts/query.js --effect relaxed --difficulty Easy
 *   node scripts/query.js --type Indica --thc-min 18
 *   node scripts/query.js --tag landrace --json
 *   node scripts/query.js --id og-kush
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH   = resolve(__dirname, "../data.json");

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith("--")) {
      const k = key.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[k] = next; i++;
      } else {
        out[k] = true;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
Usage: node scripts/query.js [options]

Options:
  --effect <v>      Effect to filter by (case-insensitive)
  --flavor <v>      Flavor to filter by
  --tag <v>         Tag to filter by
  --type <v>        Genetics type (case-insensitive)
  --difficulty <v>  Easy | Moderate | Hard
  --status <v>      complete | stub
  --thc-min <n>     THC avg lower bound
  --thc-max <n>     THC avg upper bound
  --cbd-min <n>     CBD avg lower bound
  --cbd-max <n>     CBD avg upper bound
  --id <slug>       Exact ID lookup
  --json            Output as raw JSON
  --fields <f,..>   Comma-separated fields for table display
  --help            Show this help
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Load DB
// ---------------------------------------------------------------------------
let db;
try {
  db = JSON.parse(readFileSync(DB_PATH, "utf8"));
} catch (e) {
  console.error(`❌  Cannot read ${DB_PATH}: ${e.message}`);
  process.exit(1);
}

const strains = db.strains ?? [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ci     = (v) => (v ?? "").toLowerCase();
const numArg = (k) => (args[k] !== undefined ? parseFloat(args[k]) : undefined);

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------
let results = strains.filter((s) => {
  if (args.id         && s.id !== args.id) return false;
  if (args.status     && s.status !== args.status) return false;
  if (args.difficulty && ci(s.difficulty) !== ci(args.difficulty)) return false;
  if (args.type       && ci(s.genetics?.type) !== ci(args.type)) return false;

  if (args.effect && !(s.effects ?? []).some((e) => ci(e) === ci(args.effect)))
    return false;
  if (args.flavor && !(s.flavors  ?? []).some((f) => ci(f) === ci(args.flavor)))
    return false;
  if (args.tag    && !(s.tags     ?? []).some((t) => ci(t) === ci(args.tag)))
    return false;

  const thcMin = numArg("thc-min");
  const thcMax = numArg("thc-max");
  const cbdMin = numArg("cbd-min");
  const cbdMax = numArg("cbd-max");

  if (thcMin !== undefined && (s.thc ?? -Infinity) < thcMin) return false;
  if (thcMax !== undefined && (s.thc ??  Infinity) > thcMax) return false;
  if (cbdMin !== undefined && (s.cbd ?? -Infinity) < cbdMin) return false;
  if (cbdMax !== undefined && (s.cbd ??  Infinity) > cbdMax) return false;

  return true;
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
if (results.length === 0) {
  console.log("No strains matched your query.");
  process.exit(0);
}

if (args.json) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

// Table output
const fieldList = args.fields
  ? args.fields.split(",").map((f) => f.trim())
  : ["id", "name", "status", "genetics.type", "difficulty", "thc", "cbd", "tags"];

function getField(strain, field) {
  switch (field) {
    case "thc":           return strain.thc != null ? `${strain.thc}%` : "—";
    case "cbd":           return strain.cbd != null ? `${strain.cbd}%` : "—";
    case "genetics.type": return strain.genetics?.type ?? "—";
    case "tags":          return (strain.tags ?? []).join(", ") || "—";
    case "effects":       return (strain.effects ?? []).join(", ") || "—";
    case "flavors":       return (strain.flavors  ?? []).join(", ") || "—";
    case "terpenes":      return (strain.terpenes ?? []).join(", ") || "—";
    case "breeder":       return (strain.breeder ?? []).map((b) => b.name).join(", ") || "—";
    case "parents":       return (strain.genetics?.parents ?? []).join(", ") || "—";
    default:              return strain[field] ?? "—";
  }
}

// Compute column widths
const headers = fieldList;
const rows    = results.map((s) => fieldList.map((f) => String(getField(s, f))));
const widths  = headers.map((h, i) =>
  Math.max(h.length, ...rows.map((r) => r[i].length))
);

const sep  = widths.map((w) => "─".repeat(w + 2)).join("┼");
const line = (cells) => cells.map((c, i) => ` ${c.padEnd(widths[i])} `).join("│");

console.log(`\n  Found ${results.length} strain(s):\n`);
console.log("┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐");
console.log("│" + line(headers) + "│");
console.log("├" + sep + "┤");
rows.forEach((row) => console.log("│" + line(row) + "│"));
console.log("└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘");
console.log();
