#!/usr/bin/env node
/**
 * add_strain_fields.js  —  schema v2.0
 *
 * Safely adds missing fields to every strain in data.json.
 * Existing values are NEVER overwritten — only absent / undefined fields
 * are filled with the defaults below.
 *
 * Also validates controlled-vocabulary fields against the master lists
 * stored in data.json's `meta` section.
 *
 * Usage:
 *   node add_strain_fields.js
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH   = resolve(__dirname, "data.json");

/**
 * Default values for every field in schema v2.0.
 * Nested-object defaults are merged one level deep (shallow).
 * Existing values are never touched.
 */
const FIELD_DEFAULTS = {
  id:         null,
  status:     "stub",   // "complete" | "stub"
  name:       "Unknown",
  breeder:    [],
  thc:        { min: null, max: null },
  cbd:        { min: null, max: null },
  terpenes:   [],
  genetics: {
    type:    null,
    parents: [],
  },
  effects:   [],
  flavors:   [],
  flowering_time_weeks: {
    indoor:  { min: null, max: null },
    outdoor: { min: null, max: null },
  },
  yield: {
    indoor_g_m2:    null,
    outdoor_g_plant: null,
  },
  difficulty:  null,
  tags:        [],
  description: "",
  created_at:  new Date().toISOString().slice(0, 10),
  updated_at:  new Date().toISOString().slice(0, 10),
};

const DIFFICULTY_VALUES = new Set(["Easy", "Moderate", "Hard", null]);
const STATUS_VALUES     = new Set(["complete", "stub"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Merges missing keys from `defaults` into `target` — one level deep.
 * Returns a new object; never mutates.
 */
function applyDefaults(target, defaults, log) {
  const result = { ...target };

  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (!(key in result) || result[key] === undefined) {
      result[key] = Array.isArray(defaultValue)
        ? [...defaultValue]
        : isPlainObject(defaultValue)
        ? { ...defaultValue }
        : defaultValue;
      log(`  + Added missing field "${key}"`);

    } else if (isPlainObject(defaultValue) && isPlainObject(result[key])) {
      // Shallow-merge nested objects
      const merged      = { ...result[key] };
      let madeChanges   = false;

      for (const [childKey, childDefault] of Object.entries(defaultValue)) {
        if (!(childKey in merged) || merged[childKey] === undefined) {
          merged[childKey] = Array.isArray(childDefault)
            ? [...childDefault]
            : childDefault;
          log(`  + Added missing nested field "${key}.${childKey}"`);
          madeChanges = true;
        }
      }

      if (madeChanges) result[key] = merged;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateStrain(strain, meta) {
  const warnings = [];
  const label    = strain.name ?? strain.id ?? "unknown";

  if (!STATUS_VALUES.has(strain.status)) {
    warnings.push(`  ⚠  "status" must be "complete" or "stub" — got: "${strain.status}"`);
  }
  if (!DIFFICULTY_VALUES.has(strain.difficulty)) {
    warnings.push(`  ⚠  "difficulty" must be "Easy", "Moderate", "Hard", or null — got: "${strain.difficulty}"`);
  }

  const numericRange = (field) => {
    const v = strain[field];
    if (!isPlainObject(v)) return warnings.push(`  ⚠  "${field}" must be an object with min/max`);
    if (v.min !== null && (typeof v.min !== "number" || v.min < 0 || v.min > 100))
      warnings.push(`  ⚠  "${field}.min" must be a number 0–100`);
    if (v.max !== null && (typeof v.max !== "number" || v.max < 0 || v.max > 100))
      warnings.push(`  ⚠  "${field}.max" must be a number 0–100`);
    if (v.min !== null && v.max !== null && v.min > v.max)
      warnings.push(`  ⚠  "${field}.min" must be ≤ "${field}.max"`);
  };
  numericRange("thc");
  numericRange("cbd");

  // Controlled vocabulary checks (only warn, not block — meta lists can grow)
  const checkVocab = (field) => {
    const allowed = new Set(meta[field] ?? []);
    const invalid = (strain[field] ?? []).filter((v) => !allowed.has(v));
    if (invalid.length)
      warnings.push(`  ⚠  "${field}" contains values not in meta list: ${JSON.stringify(invalid)}`);
  };
  checkVocab("effects");
  checkVocab("flavors");
  checkVocab("tags");

  if (
    strain.genetics?.type !== null &&
    strain.genetics?.type !== undefined &&
    !(meta.genetics_types ?? []).includes(strain.genetics.type)
  ) {
    warnings.push(`  ⚠  "genetics.type" "${strain.genetics.type}" is not in meta.genetics_types`);
  }

  // breeder must be an array of objects
  if (!Array.isArray(strain.breeder)) {
    warnings.push(`  ⚠  "breeder" must be an array`);
  } else {
    strain.breeder.forEach((b, i) => {
      if (!isPlainObject(b))
        warnings.push(`  ⚠  "breeder[${i}]" must be an object with name/country/type`);
      else if (b.type && !["commercial", "private"].includes(b.type))
        warnings.push(`  ⚠  "breeder[${i}].type" must be "commercial" or "private" — got: "${b.type}"`);
    });
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // 1. Load DB
  let db;
  try {
    db = JSON.parse(readFileSync(DB_PATH, "utf8"));
  } catch (err) {
    console.error(`❌  Could not read ${DB_PATH}:`, err.message);
    process.exit(1);
  }

  if (!Array.isArray(db.strains)) {
    console.error('❌  data.json must have a top-level "strains" array.');
    process.exit(1);
  }

  const meta = db.meta ?? {};

  // 2. Process strains
  let totalChanged  = 0;
  let totalWarnings = 0;

  db.strains = db.strains.map((strain, idx) => {
    const label = strain.name ?? strain.id ?? `[index ${idx}]`;
    console.log(`\nChecking: ${label} (${strain.status ?? "no status"})`);

    const messages = [];
    const log      = (msg) => messages.push(msg);

    const before  = JSON.stringify(strain);
    const updated = applyDefaults(strain, FIELD_DEFAULTS, log);
    const after   = JSON.stringify(updated);

    if (before === after) {
      console.log("  ✓ No missing fields.");
    } else {
      messages.forEach((m) => console.log(m));
      totalChanged++;
    }

    const warnings = validateStrain(updated, meta);
    warnings.forEach((w) => {
      console.warn(w);
      totalWarnings++;
    });

    return updated;
  });

  // 3. Write if changed
  if (totalChanged === 0) {
    console.log("\n✅  All strains complete — nothing to write.");
  } else {
    try {
      writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + "\n", "utf8");
      console.log(`\n✅  Updated ${totalChanged} strain(s) — saved to data.json.`);
    } catch (err) {
      console.error(`❌  Could not write ${DB_PATH}:`, err.message);
      process.exit(1);
    }
  }

  if (totalWarnings > 0) {
    console.warn(`\n⚠   ${totalWarnings} validation warning(s) — review output above.`);
    process.exit(1);
  }
}

main();
