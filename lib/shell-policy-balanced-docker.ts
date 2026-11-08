/**
 * Shell policy — read-only container queries for balanced mode.
 *
 * Allows only listing/inspecting what is already running or pulled:
 *   docker|podman ps | images | image ls | container ls | compose ps | logs [--tail N] [-t] <name>
 * Everything else keeps asking: `-H/--host/--context` (remote daemons), `logs -f` (never exits),
 * `exec/run/rm/stop/pull/build/cp/inspect --format` (templates), compose with `-f`, and unknown flags.
 */
import type { Segment } from "./shell-parser.js";

const DOCKER_CLIS = new Set(["docker", "podman"]);
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const LIST_FLAG = /^-[aql]+$|^--(?:all|quiet|no-trunc|latest)$/;
const LOG_FLAGS = new Set(["-t", "--timestamps", "--details"]);
const COUNT = /^(?:\d{1,6}|all)$/;

function listOnly(args: string[]): boolean {
  return args.every((arg) => LIST_FLAG.test(arg));
}

function logsOk(args: string[]): boolean {
  let name: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (LOG_FLAGS.has(arg)) continue;
    if (arg === "--tail" || arg === "-n") {
      const value = args[i + 1];
      if (value === undefined || !COUNT.test(value)) return false;
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) return false; // -f/--follow, --since, --until, unknown
    if (name !== null || !NAME.test(arg)) return false;
    name = arg;
  }
  return name !== null;
}

/** True when `segment` is a docker/podman command that only lists or reads logs. */
export function dockerReadOnlySegment(segment: Segment): boolean {
  if (!DOCKER_CLIS.has(segment.command)) return false;
  const args = segment.argv.slice(1);
  const [sub, ...rest] = args;
  if (!sub || sub.startsWith("-")) return false;
  switch (sub) {
    case "ps":
    case "images":
      return listOnly(rest);
    case "image":
    case "container":
      return (rest[0] === "ls" || rest[0] === "list") && listOnly(rest.slice(1));
    case "compose":
      return rest[0] === "ps" && listOnly(rest.slice(1));
    case "logs":
      return logsOk(rest);
    default:
      return false;
  }
}
