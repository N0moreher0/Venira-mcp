// Argument-name hints for batch tools. Batch items are untyped records, so the zod layer
// cannot reject a misspelled key (`path` instead of `relative_path`) up front. These helpers
// validate items BEFORE anything runs and tell the caller the exact field to use.
// Behaviour stays fail-fast: we only suggest, we never silently remap a key.

/** Fields accepted by edit_file (one edit_batch item). */
export const EDIT_ITEM_KEYS = [
  "relative_path",
  "old_text",
  "new_text",
  "replace_all",
  "edits",
  "expected_sha256",
  "old_text_fuzzy",
  "fuzzy_distance",
  "ignore_indentation",
  "case_insensitive",
  "reason",
] as const;

/**
 * Keys still accepted at runtime but not advertised in the tool schema (ROADMAP_TOOL_SCHEMA.md,
 * phase 1): `old_text_fuzzy` was never read by any handler, so it stays in EDIT_ITEM_KEYS and an
 * older client's leftover field is not reported as unknown. `guard` was removed in phase 5 and is
 * no longer accepted: edit_batch rejects it as an unknown field before anything runs, and edit_file
 * answers `[unsupported]` with the expected_sha256 replacement.
 */
export const EDIT_ITEM_LEGACY_KEYS = ["old_text_fuzzy"] as const;

/**
 * Fuzzy-match options. Advertised in the edit_file / edit_batch schema only when VENIRA_EDIT_FUZZY=1
 * (ROADMAP_TOOL_SCHEMA.md, phase 3). They stay in EDIT_ITEM_KEYS either way, so edit_batch never reports
 * them as unknown fields; with fuzzy off the handler rejects them with a message that names the variable.
 */
export const EDIT_ITEM_FUZZY_KEYS = ["fuzzy_distance", "ignore_indentation", "case_insensitive"] as const;

/**
 * Names of fuzzy options a caller actually asked for: `fuzzy_distance` when present, the two flags when
 * truthy (true, 1 or "1"; batch items are loose objects, so a flag can still be a raw number). An explicit
 * `0`/`false` asks for nothing, so it is not reported.
 */
export function fuzzyEditArgsUsed(args: Record<string, unknown>): string[] {
  const used: string[] = [];
  if (args.fuzzy_distance !== undefined && args.fuzzy_distance !== null) used.push("fuzzy_distance");
  for (const key of ["ignore_indentation", "case_insensitive"] as const) {
    const value = args[key];
    if (value === true || value === 1 || value === "1") used.push(key);
  }
  return used;
}

/** Fields accepted by one entry of edit_file's `edits[]`. */
export const EDIT_OP_KEYS = ["old_text", "new_text", "replace_all"] as const;

/** Common wrong names models send, mapped to the real field. */
const KEY_ALIASES: Record<string, string> = {
  path: "relative_path",
  file: "relative_path",
  filepath: "relative_path",
  file_path: "relative_path",
  filename: "relative_path",
  relativepath: "relative_path",
  old: "old_text",
  old_string: "old_text",
  oldtext: "old_text",
  old_str: "old_text",
  new: "new_text",
  new_string: "new_text",
  newtext: "new_text",
  new_str: "new_text",
  sha256: "expected_sha256",
};

const MAX_ERRORS = 12;

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return prev[b.length];
}

/** Best-known field for an unknown key, or undefined when nothing is close enough. */
export function suggestKey(unknownKey: string, known: readonly string[]): string | undefined {
  const lower = unknownKey.toLowerCase();
  const alias = KEY_ALIASES[lower];
  if (alias && known.includes(alias)) return alias;
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const distance = levenshtein(lower, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const limit = Math.max(2, Math.floor(lower.length / 3));
  return best !== undefined && bestDistance <= limit ? best : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(where: string, item: Record<string, unknown>, known: readonly string[], errors: string[]): void {
  for (const key of Object.keys(item)) {
    if (known.includes(key)) continue;
    const suggestion = suggestKey(key, known);
    errors.push(
      suggestion
        ? `${where}.${key}: unknown field, did you mean '${suggestion}'?`
        : `${where}.${key}: unknown field (allowed: ${known.join(", ")})`,
    );
  }
}

/**
 * Validate every edit_batch item up front. Returns human-readable errors (empty = valid).
 * Callers reject the whole batch on any error so nothing is applied.
 */
export function validateEditBatchItems(items: unknown[]): string[] {
  const errors: string[] = [];
  for (const [index, item] of items.entries()) {
    const where = `edits[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${where}: must be an object of edit_file arguments`);
      continue;
    }
    checkKeys(where, item, EDIT_ITEM_KEYS, errors);
    const rel = item.relative_path;
    if (typeof rel !== "string" || rel.trim() === "") {
      if (!errors.some((e) => e.startsWith(`${where}.`) && e.includes("'relative_path'"))) {
        errors.push(`${where}: missing required field 'relative_path' (workspace-relative path)`);
      }
    }
    if (Array.isArray(item.edits)) {
      for (const [opIndex, op] of item.edits.entries()) {
        const opWhere = `${where}.edits[${opIndex}]`;
        if (!isRecord(op)) errors.push(`${opWhere}: must be an object with old_text/new_text`);
        else checkKeys(opWhere, op, EDIT_OP_KEYS, errors);
      }
    }
    if (errors.length >= MAX_ERRORS) {
      errors.length = MAX_ERRORS;
      errors.push("more errors omitted; fix these first");
      break;
    }
  }
  return errors;
}

/**
 * read_batch items are independent, so a bad item only fails itself. Flags the one mistake
 * that otherwise reaches the backend as a confusing error: a path alias used instead of
 * `relative_path`. Returns an error message or undefined.
 */
export function checkReadItemKeys(operation: string, args: Record<string, unknown>): string | undefined {
  if (!isRecord(args) || "relative_path" in args) return undefined;
  for (const key of Object.keys(args)) {
    if (KEY_ALIASES[key.toLowerCase()] === "relative_path") {
      return `${operation}.arguments.${key}: unknown field, did you mean 'relative_path'? Hint: rename '${key}' to 'relative_path' (workspace-relative path) and resend this item.`;
    }
  }
  return undefined;
}
