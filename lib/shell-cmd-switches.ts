/**
 * Shell policy — cmd.exe switch grammar.
 *
 * cmd.exe built-ins and the classic Windows command-line tools accept switches in three spellings
 * the policy must see through:
 *
 *   - glued to the command name: `rd/s/q`, `xcopy/e/h`, `robocopy/log:file`
 *   - clustered in one token:     `del /f/s/q`, `xcopy /e/h/y`, `rd /s/q/`
 *   - attached values:            `attrib /a:r`, `robocopy /log:out.txt`, `xcopy /exclude:list.txt`
 *
 * Policy rules read `argv` entries, so a token such as `/log:..\outside.log` would otherwise be
 * skipped as "a switch" and its path never checked. This module normalizes only the commands and
 * switches it knows (`CMD_SWITCH_SPECS`) into the canonical `/switch value` form. If any part of a
 * token is not recognized for that command the whole token is left untouched: guessing could both
 * hide an operand and invent one.
 */

type CmdSwitchSpec = {
  /** Switches that take a value, either as the next argv entry or attached with `:`. */
  values: ReadonlySet<string>;
  /** Switches that take no value. Single-letter entries may form a cluster. */
  flags: ReadonlySet<string>;
};

const set = (value: string): ReadonlySet<string> => new Set(value.split(" ").filter(Boolean));

const DELETE_FLAGS = set("f s q p");
const DELETE_VALUES = set("a");

/**
 * Per-command switch model. Keep these lists narrow: an entry that does not exist in the real tool
 * only causes a token to be left alone (fail-closed), while a wrong entry could split a path.
 */
const CMD_SWITCH_SPECS: ReadonlyMap<string, CmdSwitchSpec> = new Map<string, CmdSwitchSpec>([
  ["del", { flags: DELETE_FLAGS, values: DELETE_VALUES }],
  ["erase", { flags: DELETE_FLAGS, values: DELETE_VALUES }],
  ["rd", { flags: set("s q"), values: set("") }],
  ["rmdir", { flags: set("s q"), values: set("") }],
  ["move", { flags: set("y v n"), values: set("") }],
  ["copy", { flags: set("a b d n v y z"), values: set("") }],
  [
    "xcopy",
    {
      flags: set("a b c e f g h i j k l m n o p q r s u v w x y z"),
      values: set("d t exclude"),
    },
  ],
  [
    "robocopy",
    {
      flags: set("s e mov move purge mir l b z np njs njh nfl ndl nc ns q fft eta bytes ts tp reg sl"),
      values: set("log tee job r w mt xf xd xo xx xc xn xl ipg max min maxage minage maxlad minlad"),
    },
  ],
  ["mklink", { flags: set("d h j"), values: set("") }],
  ["attrib", { flags: set("s d"), values: set("a") }],
  ["replace", { flags: set("a p r s u w"), values: set("") }],
]);

/** All commands whose command-name glue is accepted (`xcopy/e/h`, `del/a:r`). */
const CMD_SWITCH_COMMANDS: ReadonlySet<string> = new Set(CMD_SWITCH_SPECS.keys());

function baseName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

function isKnownSwitchPart(part: string, spec: CmdSwitchSpec): boolean {
  if (!part || part.includes(":")) return false;
  const name = part.toLowerCase();
  return /^[a-z]+$/.test(name) && (spec.flags.has(name) || spec.values.has(name));
}

/**
 * Split `/a:r/f/q` into `[/a, r, /f, /q]` for a command that knows all three switches.
 * Returns null when the token is not a fully recognized switch spelling, so the caller keeps it.
 */
function splitSwitchToken(token: string, spec: CmdSwitchSpec): string[] | null {
  if (!token.startsWith("/") || token.length < 2 || token.startsWith("//")) return null;
  let body = token.slice(1);
  // `/s/q/` is the same as `/s/q` in cmd; a trailing separator is harmless.
  while (body.endsWith("/")) body = body.slice(0, -1);
  if (!body) return null;
  const parts = body.split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) return null;
    const colon = part.indexOf(":");
    const name = (colon >= 0 ? part.slice(0, colon) : part).toLowerCase();
    const value = colon >= 0 ? part.slice(colon + 1) : null;
    if (!/^[a-z]+$/.test(name)) return null; // `/tmp/x`, `/-y`, `/?`
    if (spec.values.has(name)) {
      out.push(`/${name}`);
      if (value !== null) {
        const rest = parts.slice(i + 1);
        // A value may itself contain `/` (`/log:../outside.log`, `/log:C:/x.log`). Only keep
        // splitting when every following part is another switch this command knows.
        if (rest.length > 0 && !rest.every((candidate) => isKnownSwitchPart(candidate, spec))) {
          out.push([value, ...rest].filter(Boolean).join("/"));
          return out;
        }
        if (value.length > 0) out.push(value);
      }
      continue;
    }
    if (value !== null) return null; // a flag with an attached value: not a spelling we know
    if (!spec.flags.has(name)) return null;
    out.push(`/${name}`);
  }
  return out.length > 0 ? out : null;
}

/**
 * Canonical argv for a cmd segment: command-name glue plus switch clusters/attached values.
 * The input array is returned unchanged when nothing matched.
 */
export function normalizeCmdSwitchArgv(argv: string[]): string[] {
  if (argv.length === 0) return argv;
  let head = argv[0];
  let rest = argv.slice(1);

  const glued = /^([A-Za-z]+)(\/.+)$/.exec(head);
  if (glued && CMD_SWITCH_COMMANDS.has(glued[1].toLowerCase())) {
    const spec = CMD_SWITCH_SPECS.get(glued[1].toLowerCase());
    const split = spec ? splitSwitchToken(glued[2], spec) : null;
    if (split) {
      head = glued[1];
      rest = [...split, ...rest];
    }
  }

  const spec = CMD_SWITCH_SPECS.get(baseName(head));
  if (!spec) return argv;
  const out: string[] = [head];
  let changed = head !== argv[0] || rest.length !== argv.length - 1;
  for (const arg of rest) {
    const split = splitSwitchToken(arg, spec);
    if (split) {
      out.push(...split);
      changed = true;
    } else {
      out.push(arg);
    }
  }
  return changed ? out : argv;
}
