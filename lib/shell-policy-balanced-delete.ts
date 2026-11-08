/**
 * Shell policy — `balanced.workspace_delete`: deleting explicit single files inside the workspace.
 *
 * Allowed (bash/posix `rm`, PowerShell `Remove-Item|ri|rm|del|erase`, cmd `del|erase`) only when
 *   - the command is the bare name (no `./rm`, no path to a look-alike program) and never follows a `cd`;
 *   - every operand is one explicit path: no glob/brace/comma/list syntax, no `~`, no variables, no
 *     trailing separator, not `.`/`..`, not an NTFS stream (`file:stream`);
 *   - every operand resolves inside the workspace (symlink-safe), is not protected, not the workspace
 *     root and not a build/config/hook file (the `writeTargetOk` rules of the workspace_write tier);
 *   - an operand that exists is a regular file (not a directory, not a symlink); a missing operand is
 *     a no-op and is accepted;
 *   - no recursive/interactive/other flag: only `-f`/`-v` (posix), `-Path|-LiteralPath|-Force`
 *     (PowerShell, exact spellings: `-r` is a `-Recurse` abbreviation there) and none for cmd (`del /f /q`
 *     is already stopped by the `destructive_delete` ask rule, which runs before the balanced tiers).
 *
 * Unlike the other balanced tiers this one is only unattended because `opShellRun` stores a checkpoint
 * of the files first (`deleteTargets` in restore-checkpoint.ts) and refuses to run when it cannot:
 * the deletion is recoverable with `project_snapshot` restore.
 *
 * Recursive deletes (`rm -rf dist`, `Remove-Item -Recurse`, `rmdir /s`) keep asking.
 */
import fs from "node:fs";
import path from "node:path";
import type { ParsedCommand, Segment } from "./shell-parser.js";
import { writeTargetOk } from "./shell-policy-balanced-write.js";

const MAX_OPERANDS = 20;
const POSIX_COMMANDS = new Set(["rm"]);
const POWERSHELL_COMMANDS = new Set(["remove-item", "ri", "rm", "del", "erase"]);
const CMD_COMMANDS = new Set(["del", "erase"]);
/** One path per token: lists, globs, braces, expansion and stream syntax are all unsafe to judge statically. */
const LIST_OR_MAGIC = /[*?[\]{},;`$^"']|%[A-Za-z_][A-Za-z0-9_]*%/;

function isBareCommand(segment: Segment): boolean {
  const first = segment.argv[0] ?? "";
  return first !== "" && !/[\\/]/.test(first);
}

function operandOk(raw: string, cwd: string): boolean {
  if (!raw || raw === "." || raw === ".." || raw.startsWith("~")) return false;
  if (LIST_OR_MAGIC.test(raw) || /[\\/]$/.test(raw)) return false;
  const colon = raw.indexOf(":");
  if (colon !== -1 && colon !== 1) return false; // `C:\ws\x` is a drive, `x.txt:stream` is not a file
  if (!writeTargetOk(raw, cwd)) return false;
  try {
    const stat = fs.lstatSync(path.resolve(cwd, raw));
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"; // nothing to delete
  }
}

/** Operands of a delete segment when its flags are all on the accepted list; null otherwise. */
function parseOperands(segment: Segment, dialect: ParsedCommand["dialect"]): string[] | null {
  const args = segment.argv.slice(1).filter((arg) => arg !== "");
  const operands: string[] = [];

  if (dialect === "powershell") {
    if (!POWERSHELL_COMMANDS.has(segment.command)) return null;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      const lower = arg.toLowerCase();
      if (lower === "-force") continue;
      if (lower === "-path" || lower === "-literalpath") {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("-")) return null;
        operands.push(value);
        i += 1;
        continue;
      }
      if (arg.startsWith("-")) return null; // -Recurse, -Include, -WhatIf, abbreviations, `-Path:x` ...
      operands.push(arg);
    }
  } else if (dialect === "cmd") {
    if (!CMD_COMMANDS.has(segment.command)) return null;
    for (const arg of args) {
      if (arg.startsWith("/") || arg.startsWith("-")) return null; // every cmd switch, and the `del /tmp/x` ambiguity
      operands.push(arg);
    }
  } else {
    if (!POSIX_COMMANDS.has(segment.command)) return null;
    for (const arg of args) {
      if (/^-[fv]+$/.test(arg) || arg === "--force" || arg === "--verbose") continue;
      if (arg.startsWith("-")) return null; // -r -R -d -i -I --, --preserve-root ...
      operands.push(arg);
    }
  }
  return operands.length >= 1 && operands.length <= MAX_OPERANDS ? operands : null;
}

/** True when this segment is a single-file delete that balanced mode may run after a checkpoint. */
export function deleteSegmentOk(segment: Segment, parsed: ParsedCommand, cwd: string, cdSeen: boolean): boolean {
  if (cdSeen || !isBareCommand(segment)) return false;
  const operands = parseOperands(segment, parsed.dialect);
  return operands !== null && operands.every((operand) => operandOk(operand, cwd));
}

/** Operands of a segment that `deleteSegmentOk` accepts (for the checkpoint); empty otherwise. */
export function deleteSegmentOperands(segment: Segment, parsed: ParsedCommand, cwd: string, cdSeen: boolean): string[] {
  if (!deleteSegmentOk(segment, parsed, cwd, cdSeen)) return [];
  return parseOperands(segment, parsed.dialect) ?? [];
}
