/**
 * Provider-specific request shapes for the PR/MR URL parsers (`prNumberFrom`, `parsePrOrRepo`).
 *
 *   1. Seeds: the URL shapes GitHub, GitLab and Bitbucket really produce (GitLab's `/-/` segment and nested
 *      groups, Bitbucket's `pull-requests`, trailing tabs, query strings, fragments).
 *   2. Hostile inputs: zero, huge, negative and non-numeric numbers must be rejected, never guessed.
 *   3. A seeded random pass: parsers never throw anything but their own `[invalid_request]` / `[repo_unresolved]`
 *      errors, and whatever they accept is internally consistent (positive safe integer, valid segments).
 *
 * The random pass is deterministic. Replay a failure with `FUZZ_SEED=<n> npm run test:git-url-fuzz`.
 */
import assert from "node:assert/strict";
import { prNumberFrom } from "../lib/git-common.js";
import { parsePrOrRepo } from "../lib/git-repo.js";

let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

const pr = (value: unknown): number => prNumberFrom({ pr: value });
const repo = (raw: string): string | null => {
  const parsed = parsePrOrRepo(raw);
  return parsed ? `${parsed.owner}/${parsed.name}` : null;
};

check("github pull URLs, with tabs, query and fragment", () => {
  assert.equal(pr("https://github.com/acme/widget/pull/12"), 12);
  assert.equal(pr("https://github.com/acme/widget/pull/12/files"), 12);
  assert.equal(pr("https://github.com/acme/widget/pull/12?diff=split"), 12);
  assert.equal(pr("https://github.com/acme/widget/pull/12#discussion_r9"), 12);
  assert.equal(repo("https://github.com/acme/widget/pull/12/commits"), "acme/widget");
});

check("gitlab merge requests keep the repo, not the `-` separator", () => {
  assert.equal(pr("https://gitlab.com/acme/widget/-/merge_requests/7"), 7);
  assert.equal(pr("https://gitlab.com/acme/widget/-/merge_requests/7/diffs"), 7);
  assert.equal(repo("https://gitlab.com/acme/widget/-/merge_requests/7"), "acme/widget");
  assert.equal(repo("https://gitlab.com/acme/widget/-/merge_requests/7/diffs?view=inline"), "acme/widget");
});

check("gitlab nested groups resolve to the last two segments before `/-/`", () => {
  assert.equal(repo("https://gitlab.com/group/sub/widget/-/merge_requests/3"), "sub/widget");
  assert.equal(repo("https://gitlab.com/a/b/c/widget/-/merge_requests/3#note_1"), "c/widget");
});

check("old gitlab URLs without `/-/` still work", () => {
  assert.equal(pr("https://gitlab.com/acme/widget/merge_requests/5"), 5);
  assert.equal(repo("https://gitlab.com/acme/widget/merge_requests/5"), "acme/widget");
});

check("bitbucket pull-requests URLs", () => {
  assert.equal(pr("https://bitbucket.org/acme/widget/pull-requests/21"), 21);
  assert.equal(pr("https://bitbucket.org/acme/widget/pull-requests/21/diff"), 21);
  assert.equal(repo("https://bitbucket.org/acme/widget/pull-requests/21"), "acme/widget");
  assert.equal(repo("https://bitbucket.org/acme/widget/pull-requests/21/overview?x=1"), "acme/widget");
});

check("plain owner/name and clone URLs still parse as repos", () => {
  assert.equal(repo("acme/widget"), "acme/widget");
  assert.equal(repo("https://github.com/acme/widget.git"), "acme/widget");
  assert.equal(repo("git@github.com:acme/widget.git"), "acme/widget");
});

check("plain numbers and numeric strings", () => {
  assert.equal(pr(12), 12);
  assert.equal(pr(12.9), 12);
  assert.equal(pr(" 34 "), 34);
});

check("zero, negative, non-numeric and unsafe numbers are rejected, in every URL shape", () => {
  for (const bad of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "",
    "abc",
    "0",
    "-4",
    "https://github.com/acme/widget/pull/0",
    "https://gitlab.com/acme/widget/-/merge_requests/0",
    "https://bitbucket.org/acme/widget/pull-requests/0",
    "https://github.com/acme/widget/pull/99999999999999999999",
    "https://github.com/acme/widget/pull/12abc",
    "https://github.com/acme/widget/pulls",
    null,
    undefined,
    {},
  ]) {
    assert.throws(() => pr(bad), /\[invalid_request\]/, `should reject ${String(bad)}`);
  }
});

check("a bare `-` is never accepted as a repo name", () => {
  assert.throws(() => repo("https://gitlab.com/acme/-/merge_requests/7"), /\[repo_unresolved\]/);
});

// ---- seeded random pass ----

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seed = Number(process.env.FUZZ_SEED ?? 20261108);
const rand = mulberry32(Number.isFinite(seed) ? seed : 20261108);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];

const HOSTS = ["github.com", "gitlab.com", "bitbucket.org", "git.example.org:8443", "localhost", "[::1]"];
const WORDS = ["pull", "pulls", "issues", "merge_requests", "pull-requests", "-", "files", "diffs", "x", ""];
const JUNK = ["", "/", "?", "#", "%2F", "%00", "..", "/./", "\\", " ", "\t", "\n", "é", "😀", "0", "007", "1e3", "-1", "٣"];
const NAMES = ["acme", "widget", "a.b", "a_b", "-", "--", ".", "..", "a b", "a/b", "名前", "x".repeat(120), ""];

function randomInput(): string {
  const parts: string[] = [];
  if (rand() < 0.7) parts.push(`${pick(["https", "http", "ssh", "git", "ftp"])}://${pick(HOSTS)}`);
  const depth = 1 + Math.floor(rand() * 6);
  for (let i = 0; i < depth; i += 1) {
    parts.push(rand() < 0.5 ? pick(NAMES) : pick(WORDS));
    if (rand() < 0.3) parts.push(pick(JUNK));
  }
  parts.push(String(Math.floor(rand() * 10 ** Math.floor(rand() * 20))));
  if (rand() < 0.5) parts.push(pick(JUNK));
  return parts.join("/");
}

check("random inputs only fail with the parsers' own error codes", () => {
  const own = /^\[(invalid_request|repo_unresolved)\]/;
  let accepted = 0;
  for (let i = 0; i < 4000; i += 1) {
    const input = randomInput();
    try {
      const n = pr(input);
      assert.ok(Number.isSafeInteger(n) && n > 0, `prNumberFrom(${JSON.stringify(input)}) -> ${n}`);
      accepted += 1;
    } catch (error) {
      assert.match((error as Error).message, own, `prNumberFrom(${JSON.stringify(input)}) threw ${(error as Error).message}`);
    }
    try {
      const parsed = parsePrOrRepo(input);
      if (parsed) {
        assert.match(parsed.owner, /^[A-Za-z0-9._-]{1,100}$/, `owner of ${JSON.stringify(input)}`);
        assert.match(parsed.name, /^[A-Za-z0-9._-]{1,100}$/, `name of ${JSON.stringify(input)}`);
      }
    } catch (error) {
      assert.match((error as Error).message, own, `parsePrOrRepo(${JSON.stringify(input)}) threw ${(error as Error).message}`);
    }
  }
  assert.ok(accepted > 0, "the generator should produce some valid PR URLs, or the pass proves nothing");
});

console.log(`Git URL fuzz tests passed (${checks} checks, seed ${seed}).`);
