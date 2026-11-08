/**
 * Shell policy — read-only container queries for balanced mode.
 *
 * Allows only listing what is already running or pulled:
 *   docker|podman ps | images | image ls | container ls | compose ps   (list flags only)
 * Everything else keeps asking, including `logs` (container output can contain secrets),
 * `-H/--host/--context` (remote daemons), `exec/run/rm/stop/pull/build/cp`, `inspect`,
 * `--format/--filter`, compose with `-f`, and unknown flags.
 */
import type { Segment } from "./shell-parser.js";

const DOCKER_CLIS = new Set(["docker", "podman"]);
const LIST_FLAG = /^-[aql]+$|^--(?:all|quiet|no-trunc|latest)$/;

function listOnly(args: string[]): boolean {
  return args.every((arg) => LIST_FLAG.test(arg));
}

/** True when `segment` is a docker/podman command that only lists containers, images or compose services. */
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
    default:
      return false;
  }
}
