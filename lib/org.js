"use strict";

/**
 * org.js — Org data layer for the Software Factory.
 *
 * Roles live in org/roles/<id>.json — who the role is, its domains, brain paths.
 * Org profiles live in org/profiles/<name>.json — how roles relate to each other
 * and which role handles which factory decision point.
 *
 * These are separate concerns: a role's identity is stable; its position in an
 * org structure and its decision responsibilities are profile configuration.
 */

const fs   = require("fs");
const path = require("path");

const ROOT         = path.join(__dirname, "..");
const ROLES_DIR    = path.join(ROOT, "org", "roles");
const PROFILES_DIR = path.join(ROOT, "org", "profiles");

let _roles          = null;   // { [id]: roleObj }
let _profileCache   = {};     // { [name]: resolvedProfile }
let _activeProfileName = "default";

// ---------------------------------------------------------------------------
// Decision point registry (factory concepts — used for context building only)
// ---------------------------------------------------------------------------

const DECISION_POINTS = [
  { id: "copy-review",             description: "Approve or reject user-facing text after the copywriter's review" },
  { id: "security-finding",        description: "Decide whether to fix, defer, or accept a security scanner finding" },
  { id: "security-final-approval", description: "Give final sign-off after security analysis completes" },
  { id: "review-verdict-no-ship",  description: "Accept or override the review team's no-ship verdict" },
  { id: "review-verdict-ship",     description: "Give final approval when the review team recommends shipping" },
];

// ---------------------------------------------------------------------------
// Role loading
// ---------------------------------------------------------------------------

function loadRoles() {
  if (_roles) return _roles;
  _roles = {};
  if (!fs.existsSync(ROLES_DIR)) return _roles;
  for (const f of fs.readdirSync(ROLES_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const role = JSON.parse(fs.readFileSync(path.join(ROLES_DIR, f), "utf8"));
      _roles[role.id] = role;
    } catch {}
  }
  return _roles;
}

function reloadRoles() {
  _roles = null;
  return loadRoles();
}

// ---------------------------------------------------------------------------
// Profile loading
// ---------------------------------------------------------------------------

// Resolve a raw profile (from disk) into a working profile where each node
// has its full role object merged in.
function _resolveProfile(raw) {
  const roles = loadRoles();
  const nodes = (raw.nodes ?? [])
    .map((n) => ({ ...n, role: roles[n.roleId] ?? null }))
    .filter((n) => n.role !== null);
  return { ...raw, nodes };
}

function loadProfile(name) {
  if (_profileCache[name]) return _profileCache[name];
  const filePath = path.join(PROFILES_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`Org profile not found: ${name}`);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  _profileCache[name] = _resolveProfile(raw);
  return _profileCache[name];
}

function loadProfiles() {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  return fs.readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const name = f.replace(/\.json$/, "");
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), "utf8"));
        return { name, id: raw.id, description: raw.description ?? "" };
      } catch {
        return { name, error: true };
      }
    });
}

function setActiveProfile(name) {
  _activeProfileName = name;
}

function getActiveProfile() {
  try {
    return loadProfile(_activeProfileName);
  } catch {
    const profiles = loadProfiles().filter((p) => !p.error);
    if (profiles.length > 0) return loadProfile(profiles[0].name);
    throw new Error("No org profiles found in org/profiles/");
  }
}

function reloadAll() {
  _roles        = null;
  _profileCache = {};
}

// ---------------------------------------------------------------------------
// Profile management
// ---------------------------------------------------------------------------

function saveProfile(name, profileData) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const { nodes: _, ...rest } = profileData; // strip resolved nodes before saving
  const raw = {
    ...rest,
    nodes: (profileData.nodes ?? []).map((n) => ({
      roleId:      n.roleId ?? n.role?.id,
      escalatesTo: n.escalatesTo ?? null,
    })),
  };
  fs.writeFileSync(path.join(PROFILES_DIR, `${name}.json`), JSON.stringify(raw, null, 2), "utf8");
  delete _profileCache[name];
}

// Add a role node to a named profile. If decidesOn entries are provided, sets
// the decisionRouting for those points (only if not already claimed).
function addRoleToProfile(roleId, escalatesTo, decidesOn, profileName) {
  const filePath = path.join(PROFILES_DIR, `${profileName}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`Org profile not found: ${profileName}`);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!raw.nodes.some((n) => n.roleId === roleId)) {
    raw.nodes.push({ roleId, escalatesTo: escalatesTo ?? null });
  }
  raw.decisionRouting = raw.decisionRouting ?? {};
  for (const point of (decidesOn ?? [])) {
    if (!raw.decisionRouting[point]) raw.decisionRouting[point] = roleId;
  }
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), "utf8");
  delete _profileCache[profileName];
}

// ---------------------------------------------------------------------------
// Role management
// ---------------------------------------------------------------------------

// Creates org/roles/<id>.json and adds the role to the active profile.
// roleData may include escalatesTo and decidesOn — these go to the profile, not the role file.
function addRole(roleData) {
  fs.mkdirSync(ROLES_DIR, { recursive: true });
  const existing = loadRoles();
  if (existing[roleData.id]) throw new Error(`Role already exists: ${roleData.id}`);

  // Derive brain/transcript/token log paths under org/<id>/
  fs.mkdirSync(path.join(ROOT, "org", roleData.id), { recursive: true });
  const role = {
    id:             roleData.id,
    name:           roleData.name,
    description:    roleData.description,
    brainPath:      `org/${roleData.id}/brain.md`,
    transcriptPath: `org/${roleData.id}/brain-transcript.md`,
    tokenLogPath:   `org/${roleData.id}/brain-token-usage.jsonl`,
    contextFile:    null,
    config:         [],
    domains:        roleData.domains ?? [],
  };

  fs.writeFileSync(
    path.join(ROLES_DIR, `${role.id}.json`),
    JSON.stringify(role, null, 2), "utf8"
  );

  _roles = null;

  // Add structural position + decision routing to the active profile
  addRoleToProfile(role.id, roleData.escalatesTo ?? null, roleData.decidesOn ?? [], _activeProfileName);

  return role;
}

// ---------------------------------------------------------------------------
// Brain file helpers
// ---------------------------------------------------------------------------

function brainPath(role) {
  return path.join(ROOT, role.brainPath);
}

function brainExists(role) {
  return fs.existsSync(brainPath(role));
}

function readBrain(role) {
  return fs.readFileSync(brainPath(role), "utf8");
}

function writeBrain(role, content) {
  const p = brainPath(role);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

// ---------------------------------------------------------------------------
// Config file helpers
// ---------------------------------------------------------------------------

function getConfigPath(role) {
  return path.join(ROOT, path.dirname(role.brainPath), "brain-config.json");
}

function readRoleConfig(role) {
  const p = getConfigPath(role);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function writeRoleConfig(role, config) {
  fs.writeFileSync(getConfigPath(role), JSON.stringify(config, null, 2), "utf8");
}

// Scan all roles for a config value (roles declare which keys they own via config[]).
function readConfigValue(key) {
  const roles = loadRoles();
  for (const role of Object.values(roles)) {
    if (role.config?.includes(key)) {
      const cfg = readRoleConfig(role);
      if (cfg?.[key] != null) return cfg[key];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transcript / token log paths
// ---------------------------------------------------------------------------

function getTranscriptPath(role) {
  return path.join(ROOT, role.transcriptPath);
}

function getTokenLogPath(role) {
  return path.join(ROOT, role.tokenLogPath);
}

// ---------------------------------------------------------------------------
// Structural queries (profile-aware)
// ---------------------------------------------------------------------------

// Root nodes are those with escalatesTo: null in the profile.
function getRootRole(profile) {
  const p = profile ?? getActiveProfile();
  const rootNode = p.nodes.find((n) => !n.escalatesTo);
  return rootNode?.role ?? null;
}

// Ordered escalation chain from roleId up to the root (inclusive).
function getEscalationChain(roleId, profile) {
  const p = profile ?? getActiveProfile();
  const byId = Object.fromEntries(p.nodes.map((n) => [n.roleId, n]));
  const chain = [];
  let cur = byId[roleId];
  while (cur) {
    if (cur.role) chain.push(cur.role);
    cur = cur.escalatesTo ? byId[cur.escalatesTo] : null;
  }
  return chain;
}

// Returns the role that owns a decision point in this profile, or null.
function getRoleForDecision(point, profile) {
  const p = profile ?? getActiveProfile();
  const roleId = p.decisionRouting?.[point];
  if (!roleId) return null;
  const node = p.nodes.find((n) => n.roleId === roleId);
  return node?.role ?? null;
}

// Returns brain content for a decision point by walking the escalation chain.
// Falls back to root role, then returns null if no brain found anywhere.
function getBrainForDecision(point, profile) {
  const p = profile ?? getActiveProfile();
  const ownerRole = getRoleForDecision(point, p);

  const startRoleId = ownerRole
    ? ownerRole.id
    : (p.nodes.find((n) => !n.escalatesTo)?.roleId ?? null);

  if (!startRoleId) return null;

  const chain = getEscalationChain(startRoleId, p);
  for (const role of chain) {
    if (brainExists(role)) return readBrain(role);
  }
  return null;
}

// Roles in the active profile that have no brain file yet.
function getRolesMissingBrain(profile) {
  const p = profile ?? getActiveProfile();
  return p.nodes.filter((n) => n.role && !brainExists(n.role)).map((n) => n.role);
}

// ---------------------------------------------------------------------------
// Interview context builders
// ---------------------------------------------------------------------------

function buildRoleContext(role) {
  const domainsText = role.domains
    .map((d, i) => `${i + 1}. **${d.name}**: ${d.hint}`)
    .join("\n");

  const configNote = role.config?.length > 0
    ? `\n\n## Config Values to Extract\n\nAfter the interview, extract these structured values:\n${role.config.map((c) => `- \`${c}\``).join("\n")}`
    : "";

  return `## Role Being Interviewed\n\n**${role.name}** — ${role.description}\n\n## Domains to Cover\n\n${domainsText}${configNote}`;
}

function buildCreateRoleContext(profile) {
  const p = profile ?? getActiveProfile();
  const roles = loadRoles();

  const owned = {};
  for (const [point, roleId] of Object.entries(p.decisionRouting ?? {})) {
    owned[point] = roles[roleId]?.name ?? roleId;
  }

  const dpText = DECISION_POINTS.map((dp) => {
    const owner = owned[dp.id];
    return `- **${dp.id}**: ${dp.description}${owner ? `  *(owned by ${owner})*` : "  *(unowned)*"}`;
  }).join("\n");

  const profileRoles = p.nodes.map((n) => n.role).filter(Boolean);
  const rolesText = profileRoles.length > 0
    ? profileRoles.map((r) => `- **${r.id}** (${r.name}): ${r.description}`).join("\n")
    : "_(no roles in this profile yet)_";

  const root = getRootRole(p);

  return [
    "## Factory Context",
    "",
    "### Decision Points",
    "",
    dpText,
    "",
    "### Existing Roles in this Profile",
    "",
    rolesText,
    "",
    "### Default Escalation Target",
    "",
    root ? `${root.id} (${root.name})` : "_(no root role defined yet)_",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Role loading
  loadRoles,
  reloadRoles,
  addRole,
  // Profile loading
  loadProfile,
  loadProfiles,
  getActiveProfile,
  setActiveProfile,
  reloadAll,
  // Profile management
  saveProfile,
  addRoleToProfile,
  // Brain file helpers
  brainPath,
  brainExists,
  readBrain,
  writeBrain,
  // Config helpers
  getConfigPath,
  readRoleConfig,
  writeRoleConfig,
  readConfigValue,
  // Transcript / token log
  getTranscriptPath,
  getTokenLogPath,
  // Structural queries
  getRootRole,
  getEscalationChain,
  getRoleForDecision,
  getBrainForDecision,
  getRolesMissingBrain,
  // Context builders
  buildRoleContext,
  buildCreateRoleContext,
  // Constants
  DECISION_POINTS,
};
