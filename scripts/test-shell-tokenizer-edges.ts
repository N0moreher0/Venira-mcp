/**
 * Edge-case tests for the shell tokenizer (lib/shell-tokenizer.ts).
 *
 * `npm run coverage:shell` showed two real (non-comment) gaps in the tokenizer: the newline /
 * carriage-return branch that turns a multi-line command into `;`-separated segments, and the
 * unquoted backtick branch whose meaning depends on the dialect (command substitution in POSIX,
 * an escape in PowerShell, a literal in cmd). Both feed the policy gate, so they are pinned here.
 *
 * Run with: npm run test:shell-tokenizer-edges
 */
import "./clean-env.js"; // must stay first: keep the host environment out of dialect defaults
import assert from "node:assert/strict";

const { tokenize } = await import("../lib/shell-tokenizer.js");

let checks = 0;
function check(name: string, fn: () => void) {
  fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

const values = (raw: string, shell: string) => tokenize(raw, { shell }).tokens.map((token) => token.value);

// ---------------------------------------------------------------------------
// Newlines separate commands exactly like `;`
// ---------------------------------------------------------------------------

check("newline_lf_becomes_one_separator", () => {
  assert.deepEqual(values("ls\npwd", "bash"), ["ls", ";", "pwd"]);
  const types = tokenize("ls\npwd", { shell: "bash" }).tokens.map((token) => token.type);
  assert.deepEqual(types, ["word", "op", "word"], "the separator is an op, not a redirect");
});

check("newline_crlf_is_a_single_separator", () => {
  assert.deepEqual(values("ls\r\npwd", "bash"), ["ls", ";", "pwd"]);
  assert.deepEqual(values("ls\r\npwd", "powershell"), ["ls", ";", "pwd"]);
});

check("newline_lone_cr_is_a_separator", () => {
  assert.deepEqual(values("ls\rpwd", "bash"), ["ls", ";", "pwd"]);
});

check("newline_blank_lines_each_add_a_separator", () => {
  // Conservative on purpose: an empty segment is harmless, a swallowed separator is not.
  assert.deepEqual(values("ls\n\npwd", "bash"), ["ls", ";", ";", "pwd"]);
});

check("newline_hides_nothing_from_later_segments", () => {
  assert.deepEqual(values("echo ok\nrm -rf /", "bash"), ["echo", "ok", ";", "rm", "-rf", "/"]);
});

check("newline_inside_quotes_stays_inside_the_word", () => {
  assert.deepEqual(values("echo 'a\nb'", "bash"), ["echo", "a\nb"]);
});

// ---------------------------------------------------------------------------
// Unquoted backtick depends on the dialect
// ---------------------------------------------------------------------------

check("backtick_posix_marks_substitution", () => {
  const result = tokenize("echo `id`", { shell: "bash" });
  assert.equal(result.has_substitution, true);
  assert.deepEqual(
    result.tokens.map((token) => token.value),
    ["echo", "`id`"],
  );
});

check("backtick_cmd_is_a_plain_character", () => {
  const result = tokenize("echo `id`", { shell: "cmd" });
  assert.equal(result.has_substitution, false);
  assert.deepEqual(
    result.tokens.map((token) => token.value),
    ["echo", "`id`"],
  );
});

check("backtick_powershell_escapes_the_next_character", () => {
  const result = tokenize("echo a`b", { shell: "powershell" });
  assert.equal(result.has_substitution, false);
  assert.deepEqual(
    result.tokens.map((token) => token.value),
    ["echo", "ab"],
  );
});

check("backtick_powershell_trailing_stays_literal", () => {
  assert.deepEqual(values("echo a`", "powershell"), ["echo", "a`"]);
});

check("backtick_powershell_line_continuation_joins_lines", () => {
  assert.deepEqual(values("echo a`\nb", "powershell"), ["echo", "ab"]);
  assert.deepEqual(values("echo a`\r\nb", "powershell"), ["echo", "ab"]);
});

// ---------------------------------------------------------------------------
// PowerShell groups and script blocks cannot be judged, so they count as substitution
// ---------------------------------------------------------------------------

check("powershell_group_and_block_mark_substitution", () => {
  for (const shell of ["powershell", "pwsh"]) {
    for (const raw of ["git status (Get-Date)", "git status @(Get-Date)", "1..3 | ForEach-Object { $_ }", "git status ?? (Get-Date)"]) {
      assert.equal(tokenize(raw, { shell }).has_substitution, true, `${shell}: ${raw}`);
    }
  }
});

check("powershell_quoted_group_and_block_stay_literal", () => {
  for (const raw of ['git log --grep="(fix)"', "git log --grep='{x}'", 'echo "a {b}"']) {
    assert.equal(tokenize(raw, { shell: "powershell" }).has_substitution, false, raw);
  }
  assert.equal(tokenize('echo "$(Get-Date)"', { shell: "powershell" }).has_substitution, true, "$( inside double quotes still counts");
});

check("group_and_block_are_ordinary_characters_in_other_dialects", () => {
  for (const shell of ["bash", "cmd"]) {
    assert.equal(tokenize("echo (a) {b}", { shell }).has_substitution, false, shell);
  }
});

console.log(`\n${checks} checks passed`);
