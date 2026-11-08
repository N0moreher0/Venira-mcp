/**
 * Shell policy — `python -m pytest|mypy` as a routine dev-tool run.
 *
 * `python <script>` and `python -c` stay dynamic execution (ask). `python -m <module>` is accepted only for
 * the two modules that `pytest` / `mypy` already allow when called bare, and only when:
 *   - `python|python3|py` is the bare command (not `./python`) and `-m <module>` is the first argument;
 *   - no flag can load code or write from a place the policy cannot see (`-p`, `-c`, `-o`, `--rootdir`,
 *     `--confcutdir`, `--basetemp`, `--junitxml`, `--cache-dir`, `--config-file`, ...), including glued forms;
 *   - the workspace root holds no file or package that would shadow the module: `python -m` puts the
 *     current directory first on `sys.path`, so a just-written `pytest.py` would run instead of pytest.
 */
import fs from "node:fs";
import type { Segment } from "./shell-parser.js";

const PYTHON_COMMANDS = new Set(["python", "python3", "py"]);
/** Module -> names whose presence in the working directory would shadow it. */
const MODULES: Record<string, string[]> = {
  pytest: ["pytest", "_pytest", "pluggy", "iniconfig"],
  mypy: ["mypy", "mypyc", "typing_extensions", "mypy_extensions"],
};
const UNSAFE_FLAG =
  /^(?:-[a-z]*[pco]|--(?:plugin|plugins|rootdir|confcutdir|basetemp|junitxml|junit-xml|log-file|cache-dir|config-file|override-ini|pyargs|import-mode|html|report-log|cov-config|python-executable|custom-typeshed-dir|shadow-file|cache-map|pdb-cls|pdbcls)(?:=|$))/i;

function shadowed(cwd: string, names: string[]): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(cwd).map((entry) => entry.toLowerCase());
  } catch {
    return true; // cannot inspect the directory: do not guess
  }
  return names.some((name) => entries.some((entry) => entry === name || entry.startsWith(`${name}.`)));
}

/** True for `python -m pytest|mypy ...` that is safe to treat like the bare tool. */
export function pythonModuleRunOk(segment: Segment, cwd: string): boolean {
  const first = segment.argv[0] ?? "";
  if (!PYTHON_COMMANDS.has(segment.command) || /[\\/]/.test(first)) return false;
  const [, flag, module, ...rest] = segment.argv;
  const shadows = module ? MODULES[module.toLowerCase()] : undefined;
  if (flag !== "-m" || !shadows) return false;
  if (rest.some((arg) => UNSAFE_FLAG.test(arg))) return false;
  return !shadowed(cwd, shadows);
}
