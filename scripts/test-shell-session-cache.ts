/**
 * Unit tests for the session-grant store (lib/shell-policy-session.ts) and the shell output cache
 * (lib/shell-cache.ts). Both were weak spots in `npm run coverage:shell` (session 35.6% lines /
 * 20% functions, cache 66.8% lines / 41.4% branches).
 *
 * Run with: npm run test:shell-session-cache
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change cache/TTL behaviour
import assert from "node:assert/strict";

const session = await import("../lib/shell-policy-session.js");
const cache = await import("../lib/shell-cache.js");

type Decision = import("../lib/shell-policy.js").Decision;
const decision = (rule: string): Decision =>
  ({ tier: "ask", rule, reason: "test", mode: "balanced", command_hash: "h" }) as Decision;

let checks = 0;
function check(name: string, fn: () => void) {
  fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

/** Run `fn` with a controllable clock; always restores Date.now. */
function withClock(start: number, fn: (advance: (ms: number) => void) => void) {
  const real = Date.now;
  let now = start;
  Date.now = () => now;
  try {
    fn((ms) => {
      now += ms;
    });
  } finally {
    Date.now = real;
  }
}

// ---------------------------------------------------------------------------
// Session grants
// ---------------------------------------------------------------------------

check("session_grant_roundtrip_and_isolation", () => {
  session.clearApprovals();
  const d = decision("ask.network_access");
  assert.equal(session.hasSessionApproval("s1", d, "k"), false, "no grant yet");
  const expires = session.grantSessionApproval("s1", d, "k");
  assert.ok(expires > Date.now(), "default TTL is in the future");
  assert.equal(session.hasSessionApproval("s1", d, "k"), true);
  // A grant is bound to session, rule and key: changing any one of them must not match.
  assert.equal(session.hasSessionApproval("s2", d, "k"), false, "other session");
  assert.equal(session.hasSessionApproval("s1", decision("ask.package_mutation"), "k"), false, "other rule");
  assert.equal(session.hasSessionApproval("s1", d, "other"), false, "other key");
});

check("session_grant_clear_removes_all", () => {
  session.clearApprovals();
  const d = decision("ask.x");
  session.grantSessionApproval("s1", d, "a");
  session.grantSessionApproval("s1", d, "b");
  session.clearApprovals();
  assert.equal(session.hasSessionApproval("s1", d, "a"), false);
  assert.equal(session.hasSessionApproval("s1", d, "b"), false);
});

check("session_grant_expires_after_ttl", () => {
  session.clearApprovals();
  withClock(1_000_000, (advance) => {
    const d = decision("ask.ttl");
    const expires = session.grantSessionApproval("s1", d, "k", 1000);
    assert.equal(expires, 1_001_000);
    advance(999);
    assert.equal(session.hasSessionApproval("s1", d, "k"), true, "still valid just before expiry");
    advance(1);
    assert.equal(session.hasSessionApproval("s1", d, "k"), false, "expired at the deadline");
    // The expired entry was dropped, so it stays gone even if the clock were to move back.
    advance(-1000);
    assert.equal(session.hasSessionApproval("s1", d, "k"), false, "expired entries are deleted, not just hidden");
  });
});

check("session_grant_prunes_expired_entries_on_new_grant", () => {
  session.clearApprovals();
  withClock(5_000_000, (advance) => {
    const d = decision("ask.prune");
    session.grantSessionApproval("old", d, "k", 10);
    advance(11);
    session.grantSessionApproval("new", d, "k", 10_000); // prune() runs here and drops "old"
    advance(-11); // rewind: a surviving "old" entry would be valid again
    assert.equal(session.hasSessionApproval("old", d, "k"), false, "pruned on the next grant");
    assert.equal(session.hasSessionApproval("new", d, "k"), true);
  });
});

// ---------------------------------------------------------------------------
// Shell cache: storage, TTL, LRU
// ---------------------------------------------------------------------------

check("cache_set_get_roundtrip_and_key_isolation", () => {
  cache.clearShellCache();
  assert.equal(cache.getShellCache("git status", "/w"), null);
  cache.setShellCache("git status", "/w", "out", "err", 0);
  const hit = cache.getShellCache("git status", "/w");
  assert.deepEqual({ output: hit?.output, error: hit?.error, exitCode: hit?.exitCode }, { output: "out", error: "err", exitCode: 0 });
  assert.equal(cache.getShellCache("git status", "/other"), null, "key includes cwd");
  assert.equal(cache.getShellCache("git log", "/w"), null, "key includes command");
  assert.equal(cache.getShellCacheStats().size, 1);
  assert.equal(cache.getShellCache("git status", "/w", "cmd"), null, "key includes shell dialect");
  cache.setShellCache("git status", "/w", "cmd-output", "", 0, "cmd");
  assert.equal(cache.getShellCache("git status", "/w")?.output, "out");
  assert.equal(cache.getShellCache("git status", "/w", "cmd")?.output, "cmd-output");
  assert.equal(cache.getShellCacheStats().size, 2);
  cache.clearShellCache();
  assert.equal(cache.getShellCacheStats().size, 0);
});

check("cache_entries_expire_after_ttl", () => {
  cache.clearShellCache();
  withClock(2_000_000, (advance) => {
    cache.setShellCache("git status", "/w", "o", "", 0);
    advance(cache.getShellCacheStats().ttlMs);
    assert.ok(cache.getShellCache("git status", "/w"), "exactly at the TTL is still a hit");
    advance(cache.getShellCacheStats().ttlMs + 1);
    assert.equal(cache.getShellCache("git status", "/w"), null, "older than the TTL is a miss");
    assert.equal(cache.getShellCacheStats().size, 0, "expired entry is evicted");
  });
});

check("cache_overwrite_replaces_entry_without_growing", () => {
  cache.clearShellCache();
  cache.setShellCache("git status", "/w", "v1", "", 0);
  cache.setShellCache("git status", "/w", "v2", "", 1);
  assert.equal(cache.getShellCacheStats().size, 1);
  const hit = cache.getShellCache("git status", "/w");
  assert.equal(hit?.output, "v2");
  assert.equal(hit?.exitCode, 1);
});

check("cache_lru_evicts_least_recently_used_at_capacity", () => {
  cache.clearShellCache();
  const { maxSize } = cache.getShellCacheStats();
  for (let i = 0; i < maxSize; i += 1) cache.setShellCache(`git log -n ${i}`, "/w", `o${i}`, "", 0);
  assert.equal(cache.getShellCacheStats().size, maxSize);
  // Touch the oldest entry so it becomes most recently used; entry 1 is now the LRU victim.
  assert.ok(cache.getShellCache("git log -n 0", "/w"));
  cache.setShellCache("git log -n new", "/w", "new", "", 0);
  assert.equal(cache.getShellCacheStats().size, maxSize, "size stays capped");
  assert.ok(cache.getShellCache("git log -n 0", "/w"), "recently used entry survives");
  assert.equal(cache.getShellCache("git log -n 1", "/w"), null, "least recently used entry is evicted");
  assert.ok(cache.getShellCache("git log -n new", "/w"));
  cache.clearShellCache();
});

check("cache_refuses_non_read_only_commands", () => {
  cache.clearShellCache();
  for (const command of ["rm -rf dist", "npm install", "git push", "echo hi > out.txt", "ls | wc -l"]) {
    cache.setShellCache(command, "/w", "o", "", 0);
    assert.equal(cache.getShellCache(command, "/w"), null, `${command} must not be cached`);
  }
  assert.equal(cache.isReadOnlyCommand("echo 'first & second'", "cmd"), false, "cmd single quotes do not quote operators");
  cache.setShellCache("echo 'first & second'", "/w", "o", "", 0, "cmd");
  assert.equal(cache.getShellCache("echo 'first & second'", "/w", "cmd"), null, "cmd structural syntax is not cacheable");
  assert.equal(cache.getShellCacheStats().size, 0);
});

// ---------------------------------------------------------------------------
// Read-only classification
// ---------------------------------------------------------------------------

check("raw_shell_syntax_detection", () => {
  assert.equal(cache.hasRawShellSyntax("git status"), false);
  assert.equal(cache.hasRawShellSyntax("echo 'a > b; c | d'"), false, "single quotes are inert");
  assert.equal(cache.hasRawShellSyntax('echo "a > b; c | d"'), false, "metacharacters are inert inside double quotes");
  assert.equal(cache.hasRawShellSyntax('echo "$(date)"'), true, "$ is live inside double quotes");
  assert.equal(cache.hasRawShellSyntax("echo `date`"), true);
  assert.equal(cache.hasRawShellSyntax("cat a > b"), true);
  assert.equal(cache.hasRawShellSyntax("cat a | wc"), true);
  assert.equal(cache.hasRawShellSyntax("ls; rm x"), true);
  assert.equal(cache.hasRawShellSyntax("ls && rm x"), true);
  assert.equal(cache.hasRawShellSyntax("diff <(ls) <(ls)"), true, "process substitution");
  assert.equal(cache.hasRawShellSyntax("diff a <b"), false, "a bare < is not process substitution");
});

check("tokenize_honors_quotes", () => {
  assert.deepEqual(cache.tokenize("git log --oneline"), ["git", "log", "--oneline"]);
  assert.deepEqual(cache.tokenize("  a   b  "), ["a", "b"]);
  assert.deepEqual(cache.tokenize("echo 'a b' \"c d\""), ["echo", "a b", "c d"]);
  assert.deepEqual(cache.tokenize("echo ''"), ["echo", ""], "an empty quoted argument is kept");
  assert.deepEqual(cache.tokenize(""), []);
});

check("read_only_classification_basics", () => {
  const yes = ["ls -la", "pwd", "cat README.md", "rg foo src", "head -n 5 a.txt", "tail -n 5 a.txt", "Get-Content a.txt", "/usr/bin/ls", "node --version", "npm -v", "python3 version", "wc -l a.txt"];
  for (const command of yes) assert.equal(cache.isReadOnlyCommand(command), true, command);
  // A Windows path only parses as a program path in a Windows dialect; the default dialect follows the host OS, so name it.
  assert.equal(cache.isReadOnlyCommand("C:\\tools\\rg.exe foo", "powershell"), true, "windows path, powershell");
  const no = ["", "   ", "rm a", "touch a", "node script.js", "npm install", "python3 x.py", "node -e 1", "make"];
  for (const command of no) assert.equal(cache.isReadOnlyCommand(command), false, JSON.stringify(command));
});

check("read_only_classification_follow_and_exec_flags", () => {
  assert.equal(cache.isReadOnlyCommand("tail -f log.txt"), false);
  assert.equal(cache.isReadOnlyCommand("tail --follow log.txt"), false);
  assert.equal(cache.isReadOnlyCommand("tail -F log.txt"), false);
  assert.equal(cache.isReadOnlyCommand("Get-Content log.txt -Wait"), false);
  assert.equal(cache.isReadOnlyCommand("find . -name x"), true);
  for (const flag of ["-delete", "-ok", "-exec", "-execdir", "-okdir"]) {
    assert.equal(cache.isReadOnlyCommand(`find . ${flag} x`), false, `find ${flag}`);
  }
});

check("read_only_classification_git", () => {
  const yes = [
    "git status", "git log --oneline", "git diff HEAD", "git show HEAD", "git blame a.ts", "git rev-parse HEAD",
    "git ls-files", "git --version", "git", "git version", "git help", "git branch", "git branch -a", "git tag", "git tag -l",
    "git remote", "git remote -v", "git remote get-url origin", "git stash list", "git stash show", "git worktree list",
    "git submodule status", "git -C sub status", "git -c core.pager=cat log", "git --git-dir=x log", "git --no-pager log",
    "git --work-tree sub diff",
  ];
  for (const command of yes) assert.equal(cache.isReadOnlyCommand(command), true, command);
  const no = [
    "git push", "git commit -m x", "git checkout main", "git reset --hard", "git clean -fd", "git fetch", "git pull",
    "git branch -D x", "git branch --delete x", "git branch -m a b", "git tag -a v1", "git tag -d v1", "git tag -f v1",
    "git remote add o u", "git remote remove o", "git stash", "git stash pop", "git stash drop", "git worktree add x",
    "git submodule update", "git -C sub push",
  ];
  for (const command of no) assert.equal(cache.isReadOnlyCommand(command), false, command);
  // `-a` lists for branch but annotates (creates) for tag: the two write-flag sets must stay separate.
  assert.equal(cache.isReadOnlyCommand("git branch -a"), true);
  assert.equal(cache.isReadOnlyCommand("git tag -a v1"), false);
});

check("read_only_classification_rejects_shell_structure", () => {
  for (const command of ["ls > out", "cat a | wc", "ls; rm a", "git status && git push", "echo $(rm a)", "cat `rm a`", "ls &"]) {
    assert.equal(cache.isReadOnlyCommand(command, "bash"), false, command);
  }
});

console.log(`Shell session/cache tests passed (${checks} checks).`);
