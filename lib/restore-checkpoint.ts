/**
 * Automatic checkpoint before `git restore` overwrites the working tree or a single-file delete
 * (`balanced.workspace_delete`) removes files.
 *
 * The balanced policy lets `git restore <file>` and `rm <file>` run without approval because the change is
 * recoverable. The policy itself is a synchronous pure function and cannot take a checkpoint, so
 * `opShellRun` calls this right before spawning: it works out which workspace paths the command
 * would overwrite or delete, and stores them with `opSnapshotCreate`.
 *
 *   - explicit files that an existing checkpoint already holds byte-for-byte are not captured again
 *     (the older checkpoint is reused), so repeated restores do not push manual checkpoints out of
 *     the `VENIRA_SNAPSHOT_KEEP` window;
 *   - directories, globs, pathspecs, `.`, global git options (`-C`, `--git-dir`...) and anything after
 *     a `cd` are captured conservatively (the directory, or the whole workspace);
 *   - restores that only touch the index (`--staged` without `--worktree`) need no checkpoint.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ParsedCommand } from "./shell-parser.js";
import { opSnapshotCreate } from "./snapshots.js";
import { deleteSegmentOperands } from "./shell-policy-balanced-delete.js";
import { hashBuffer, listManifests, normalizeRel } from "./snapshot-store.js";

const CD_COMMANDS = new Set(["cd", "chdir", "set-location", "sl", "pushd", "popd"]);
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--exec-path", "--namespace"]);
const MAGIC = /[*?[\]]/;

export type RestoreTargets = {
  /** Workspace-relative paths to capture (files or directories; "." is the whole workspace). */
  paths: string[];
  /** True when every path is an existing regular file named explicitly by the command. */
  explicitFilesOnly: boolean;
};

export type RestoreCheckpoint = {
  id: string;
  paths: string[];
  /** An existing checkpoint already held these exact file contents; nothing new was written. */
  reused: boolean;
  truncated: boolean;
};

async function statOrNull(abs: string) {
  try {
    return await fs.stat(abs);
  } catch {
    return null;
  }
}

/** Workspace paths that the `git restore` segments of `parsed` would overwrite, or null when none do. */
export async function restoreTargets(parsed: ParsedCommand, cwd: string, root: string): Promise<RestoreTargets | null> {
  const found = new Set<string>();
  let explicitFilesOnly = true;
  let any = false;
  let cdSeen = false;

  for (const segment of parsed.segments) {
    if (CD_COMMANDS.has(segment.command)) {
      cdSeen = true;
      continue;
    }
    if (segment.command !== "git") continue;

    let wide = cdSeen;
    let i = 1;
    for (; i < segment.argv.length; i += 1) {
      const arg = segment.argv[i];
      if (!arg.startsWith("-")) break;
      wide = true; // any global option may redirect the repository or working tree
      if (GIT_VALUE_FLAGS.has(arg)) i += 1;
    }
    if ((segment.argv[i] ?? "").toLowerCase() !== "restore") continue;

    const rest = segment.argv.slice(i + 1);
    const staged = rest.includes("--staged") || rest.includes("-S");
    const worktree = rest.includes("--worktree") || rest.includes("-W");
    if (staged && !worktree) continue;

    any = true;
    const operands: string[] = [];
    for (let j = 0; j < rest.length; j += 1) {
      const arg = rest[j];
      if (arg === "-s" || arg === "--source") {
        j += 1; // the revision is not a path
        continue;
      }
      if (arg === "--") continue;
      if (arg.startsWith("-")) continue;
      operands.push(arg);
    }

    if (wide || operands.length === 0) {
      explicitFilesOnly = false;
      found.add(".");
      continue;
    }
    for (const raw of operands) {
      let target = raw;
      if (MAGIC.test(raw) || raw.startsWith(":")) {
        // Glob or pathspec magic: capture the directory the pattern starts in.
        const literal = raw.startsWith(":") ? "" : raw.slice(0, raw.search(MAGIC));
        const cut = Math.max(literal.lastIndexOf("/"), literal.lastIndexOf("\\"));
        target = cut > 0 ? literal.slice(0, cut) : ".";
        explicitFilesOnly = false;
      }
      const abs = path.resolve(cwd, target);
      const stat = await statOrNull(abs);
      if (!stat) continue; // a deleted tracked file: nothing on disk to lose
      if (!stat.isFile()) explicitFilesOnly = false;
      found.add(normalizeRel(root, abs) || ".");
    }
  }

  if (!any || found.size === 0) return null;
  return { paths: [...found], explicitFilesOnly };
}

/**
 * Existing regular files that the single-file delete segments of `parsed` (the ones `balanced.workspace_delete`
 * would run unattended) are about to remove, or null when none. Missing operands are no-ops.
 */
export async function deleteTargets(parsed: ParsedCommand, cwd: string, root: string): Promise<RestoreTargets | null> {
  const found = new Set<string>();
  let cdSeen = false;
  for (const segment of parsed.segments) {
    if (CD_COMMANDS.has(segment.command)) {
      cdSeen = true;
      continue;
    }
    for (const operand of deleteSegmentOperands(segment, parsed, cwd, cdSeen)) {
      const abs = path.resolve(cwd, operand);
      const stat = await statOrNull(abs);
      if (stat?.isFile()) found.add(normalizeRel(root, abs));
    }
  }
  return found.size === 0 ? null : { paths: [...found], explicitFilesOnly: true };
}

/** True when some existing checkpoint holds every file byte-for-byte; returns its id. */
async function findCoveringCheckpoint(paths: string[], root: string): Promise<string | null> {
  const hashes = new Map<string, string>();
  for (const rel of paths) {
    try {
      hashes.set(rel.replace(/\\/g, "/"), hashBuffer(await fs.readFile(path.join(root, rel))));
    } catch {
      return null;
    }
  }
  for (const manifest of await listManifests()) {
    const held = new Map(manifest.files.map((file) => [file.path.replace(/\\/g, "/"), file.sha256]));
    if ([...hashes].every(([rel, sha]) => held.get(rel) === sha)) return manifest.id;
  }
  return null;
}

/**
 * Take (or reuse) the checkpoint for the `git restore` and single-file delete segments in `parsed`.
 * Returns null when the command overwrites or deletes nothing. Throws when the checkpoint cannot be stored.
 */
export async function checkpointBeforeRestore(
  parsed: ParsedCommand,
  cwd: string,
  root: string,
): Promise<RestoreCheckpoint | null> {
  const restore = await restoreTargets(parsed, cwd, root);
  const removal = await deleteTargets(parsed, cwd, root);
  if (!restore && !removal) return null;
  const targets: RestoreTargets = {
    paths: [...new Set([...(restore?.paths ?? []), ...(removal?.paths ?? [])])],
    explicitFilesOnly: (restore?.explicitFilesOnly ?? true) && (removal?.explicitFilesOnly ?? true),
  };

  if (targets.explicitFilesOnly) {
    const covering = await findCoveringCheckpoint(targets.paths, root);
    if (covering) return { id: covering, paths: targets.paths, reused: true, truncated: false };
  }

  const kind = restore && removal ? "git restore + delete" : removal ? "delete" : "git restore";
  const label = `auto: before ${kind} ${targets.paths.join(" ")}`.slice(0, 300);
  const response = await opSnapshotCreate({ paths: targets.paths, label }, root);
  const data = (response.result?.data ?? {}) as { id?: unknown; truncated?: unknown };
  if (typeof data.id !== "string") throw new Error("snapshot_create returned no checkpoint id");
  return { id: data.id, paths: targets.paths, reused: false, truncated: data.truncated === true };
}
