#!/usr/bin/env node
/**
 * scripts/validate.js  —  schema v2.0
 *
 * Validates data.json for:
 *  1. Required fields and correct types
 *  2. Controlled vocabulary (effects, flavors, tags, genetics.type)
 *  3. THC/CBD range logic (min ≤ max, 0–100)
 *  4. Referential integrity (genetics.parents IDs must exist in the DB)
 *  5. Breeder object structure
 *  6. Duplicate IDs
 *
 * Usage:
 *   node scripts/validate.js
 *   node scripts/validate.js --stubs     # include stub entries in checks
 *   node scripts/validate.js --strict    # exit 1 on any warning (default: only errors)
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more errors or (in strict mode) warnings found
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH   = resolve(__dirname, "../data.json");

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args       = process.argv.slice(2);
const inclStubs  = args.includes("--stubs");
const strict     = args.includes("--strict");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const isObj   = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isArr   = (v) => Array.isArray(v);
const isNum   = (v) => typeof v === "number" && isFinite(v);
const isStr   = (v) => typeof v === "string";

let errors   = 0;
let warnings = 0;

function err(id, msg)  { console.error(`  ❌  [${id}] ${msg}`); errors++; }
function warn(id, msg) { console.warn (`  ⚠   [${id}] ${msg}`); warnings++; }

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
let db;
try {
  db = JSON.parse(readFileSync(DB_PATH, "utf8"));
} catch (e) {
  console.error(`❌  Cannot read ${DB_PATH}: ${e.message}`);
  process.exit(1);
}

if (!isObj(db) || !isArr(db.strains)) {
  console.error('❌  data.json must be an object with a "strains" array.');
  process.exit(1);
}

const meta       = db.meta ?? {};
const strains    = db.strains;
const allowedEffects = new Set(meta.effects    ?? []);
const allowedFlavors = new Set(meta.flavors    ?? []);
const allowedTags    = new Set(meta.tags       ?? []);
const allowedTypes   = new Set(meta.genetics_types ?? []);
const allIds         = new Set(strains.map((s) => s.id).filter(Boolean));

// ---------------------------------------------------------------------------
// Run checks
// ---------------------------------------------------------------------------
console.log(`\n📋  Validating ${strains.length} strain(s) in data.json...\n`);

// 1. Duplicate IDs
const seen = new Map();
strains.forEach((s, i) => {
  if (!s.id) return;
  if (seen.has(s.id)) err(s.id, `Duplicate ID — also at index ${seen.get(s.id)}`);
  else seen.set(s.id, i);
});

// 2. Per-strain checks
strains.forEach((strain) => {
  const id      = strain.id ?? `[index ${strains.indexOf(strain)}]`;
  const isStub  = strain.status === "stub";

  if (isStub && !inclStubs) {
    // Skip stubs unless --stubs flag is passed
    return;
  }

  const label = `${id}${isStub ? " (stub)" : ""}`;
  console.log(`Checking: ${label}`);

  // --- Required string fields ---
  if (!isStr(strain.id) || !strain.id)
    err(id, '"id" is required and must be a non-empty string');

  if (!["complete", "stub"].includes(strain.status))
    err(id, `"status" must be "complete" or "stub" — got: ${JSON.stringify(strain.status)}`);

  if (!isStr(strain.name) || !strain.name)
    err(id, '"name" is required and must be a non-empty string');

  // --- Breeder ---
  if (!isArr(strain.breeder)) {
    err(id, '"breeder" must be an array');
  } else {
    strain.breeder.forEach((b, i) => {
      if (!isObj(b)) return err(id, `"breeder[${i}]" must be an object`);
      if (!isStr(b.name))    err(id, `"breeder[${i}].name" must be a string`);
      if (!isStr(b.country)) err(id, `"breeder[${i}].country" must be a string`);
      if (!["commercial", "private"].includes(b.type))
        err(id, `"breeder[${i}].type" must be "commercial" or "private" — got: ${JSON.stringify(b.type)}`);
    });
  }

  // --- THC / CBD ({min, max} objects) ---
  const checkRange = (field) => {
    const v = strain[field];
    if (!isObj(v)) return err(id, `"${field}" must be an object with min/max`);
    if (v.min !== null && (!isNum(v.min) || v.min < 0 || v.min > 100))
      err(id, `"${field}.min" must be a number 0–100 or null`);
    if (v.max !== null && (!isNum(v.max) || v.max < 0 || v.max > 100))
      err(id, `"${field}.max" must be a number 0–100 or null`);
    if (v.min !== null && v.max !== null && v.min > v.max)
      err(id, `"${field}.min" (${v.min}) must be ≤ max (${v.max})`);
  };
  checkRange("thc");
  checkRange("cbd");

  // --- Terpenes ---
  if (!isArr(strain.terpenes))
    err(id, '"terpenes" must be an array');

  // --- Genetics ---
  if (!isObj(strain.genetics)) {
    err(id, '"genetics" must be an object');
  } else {
    const gType = strain.genetics.type;
    if (gType !== null && !allowedTypes.has(gType))
      warn(id, `"genetics.type" "${gType}" not in meta.genetics_types`);

    if (!isArr(strain.genetics.parents)) {
      err(id, '"genetics.parents" must be an array');
    } else {
      strain.genetics.parents.forEach((p) => {
        if (p !== null && !allIds.has(p))
          err(id, `"genetics.parents" references unknown ID: "${p}"`);
      });
    }
  }

  // --- Controlled vocabularies ---
  const checkVocab = (field, allowed) => {
    if (!isArr(strain[field])) return err(id, `"${field}" must be an array`);
    strain[field].forEach((v) => {
      if (!allowed.has(v))
        warn(id, `"${field}" value "${v}" is not in meta.${field}`);
    });
  };
  checkVocab("effects", allowedEffects);
  checkVocab("flavors",  allowedFlavors);
  checkVocab("tags",     allowedTags);

  // --- Flowering time ---
  const checkWeekRange = (env) => {
    const v = strain.flowering_time_weeks?.[env];
    if (!isObj(v)) return err(id, `"flowering_time_weeks.${env}" must be an object`);
    if (v.min !== null && (!isNum(v.min) || v.min < 1 || v.min > 52))
      err(id, `"flowering_time_weeks.${env}.min" must be 1–52 or null`);
    if (v.max !== null && (!isNum(v.max) || v.max < 1 || v.max > 52))
      err(id, `"flowering_time_weeks.${env}.max" must be 1–52 or null`);
    if (v.min !== null && v.max !== null && v.min > v.max)
      err(id, `"flowering_time_weeks.${env}.min" must be ≤ max`);
  };
  if (!isObj(strain.flowering_time_weeks))
    err(id, '"flowering_time_weeks" must be an object');
  else { checkWeekRange("indoor"); checkWeekRange("outdoor"); }

  // --- Yield ---
  if (!isObj(strain.yield)) {
    err(id, '"yield" must be an object');
  } else {
    ["indoor_g_m2", "outdoor_g_plant"].forEach((k) => {
      if (strain.yield[k] !== null && (!isNum(strain.yield[k]) || strain.yield[k] < 0))
        err(id, `"yield.${k}" must be a positive number or null`);
    });
  }

  // --- Difficulty ---
  if (!["Easy", "Moderate", "Hard", null].includes(strain.difficulty))
    err(id, `"difficulty" must be "Easy", "Moderate", "Hard", or null — got: ${JSON.stringify(strain.difficulty)}`);

  // --- Timestamps ---
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(strain.created_at)) err(id, '"created_at" must be YYYY-MM-DD');
  if (!dateRe.test(strain.updated_at)) err(id, '"updated_at" must be YYYY-MM-DD');

  // --- Completeness hint for complete strains ---
  if (!isStub) {
    if (!strain.description) warn(id, '"description" is empty on a complete strain');
    if ((strain.effects ?? []).length === 0)  warn(id, '"effects" is empty on a complete strain');
    if ((strain.flavors  ?? []).length === 0) warn(id, '"flavors" is empty on a complete strain');
    if ((strain.terpenes ?? []).length === 0) warn(id, '"terpenes" is empty on a complete strain');
  }

  console.log("  ✓ Done\n");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("─".repeat(50));
if (errors === 0 && warnings === 0) {
  console.log("✅  All checks passed — no errors or warnings.");
} else {
  if (errors   > 0) console.error(`❌  ${errors} error(s) found.`);
  if (warnings > 0) console.warn (`⚠   ${warnings} warning(s) found.`);
}

process.exit(errors > 0 || (strict && warnings > 0) ? 1 : 0);
