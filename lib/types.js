"use strict";

/**
 * types.js — Type registry for the Darkroom pipeline.
 *
 * Maps semantic type names to their canonical paths relative to a run
 * directory. null means event type — no file, routes via log signals only.
 *
 * This is the single source of truth for where every inter-department
 * artifact lives. Department schemas declare inputs/outputs using these
 * names; the graph executor resolves them to absolute paths before each
 * node runs and writes io-context.json so department runners never need
 * to hardcode paths themselves.
 */

const path = require("path");

const TYPES = {
  // ── Handoff artifacts (Design → downstream) ─────────────────────────────
  "design-spec":      "handoff/build-spec.md",
  "review-spec":      "handoff/review-spec.md",
  "runtime-spec":     "handoff/runtime-spec.md",
  "factory-manifest": "handoff/factory-manifest.json",

  // ── Build output ─────────────────────────────────────────────────────────
  "build-artifact":   "artifact/MANIFEST.txt",

  // ── Events (log-signal routing only, no file) ────────────────────────────
  "event:ship-approved":     null,
  "event:ship-rejected":     null,
  "event:security-approved": null,
  "event:security-rejected": null,
  "event:build-complete":    null,
};

/**
 * Resolve a list of type names to absolute file paths within a run directory.
 * Event types (null paths) are silently omitted from the result.
 *
 * @param {string[]} typeNames
 * @param {string}   runDir
 * @returns {{ [typeName: string]: string }}
 */
function resolve(typeNames, runDir) {
  const result = {};
  for (const name of typeNames) {
    const relPath = TYPES[name];
    if (relPath) result[name] = path.join(runDir, relPath);
  }
  return result;
}

module.exports = TYPES;
module.exports.resolve = resolve;
