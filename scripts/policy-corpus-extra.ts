export type PolicyCorpusCase = {
  command: string;
  shell?: string;
  expected_tier: string;
  expected_rule: string;
  description: string;
};

export const extraPolicyCorpus: PolicyCorpusCase[] = [
  {
    "command": "git status",
    "shell": "bash",
    "expected_tier": "allow",
    "expected_rule": "safe_command",
    "description": "safe git read-only command"
  },
  {
    "command": "git diff --stat",
    "shell": "bash",
    "expected_tier": "allow",
    "expected_rule": "safe_command",
    "description": "safe git read-only command"
  },
  {
    "command": "git log -5",
    "shell": "bash",
    "expected_tier": "allow",
    "expected_rule": "safe_command",
    "description": "safe git read-only command"
  },
  {
    "command": "git branch --show-current",
    "shell": "bash",
    "expected_tier": "allow",
    "expected_rule": "safe_command",
    "description": "safe git read-only command"
  },
  {
    "command": "git show --stat",
    "shell": "bash",
    "expected_tier": "allow",
    "expected_rule": "safe_command",
    "description": "safe git read-only command"
  },
  {
    "command": "cat README.md",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace file read"
  },
  {
    "command": "cat package.json",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace file read"
  },
  {
    "command": "cat server.ts",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace file read"
  },
  {
    "command": "cat lib/corehost.ts",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace file read"
  },
  {
    "command": "cat scripts/verify.ts",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace file read"
  },
  {
    "command": "cat TODO.md",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace file read"
  },
  {
    "command": "cat LICENSE-MIT",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace file read"
  },
  {
    "command": "cat LICENSE-APACHE",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace file read"
  },
  {
    "command": "cat tsconfig.json",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace file read"
  },
  {
    "command": "cat opencode.example.json",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace file read"
  },
  {
    "command": "head -n 5 README.md",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "head -n 5 package.json",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "head -n 5 server.ts",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "head -n 5 lib/corehost.ts",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "head -n 5 scripts/verify.ts",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "head -n 5 TODO.md",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "head -n 5 LICENSE-MIT",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "head -n 5 LICENSE-APACHE",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "head -n 5 tsconfig.json",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "head -n 5 opencode.example.json",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "tail -n 5 README.md",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "tail -n 5 package.json",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "tail -n 5 server.ts",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "tail -n 5 lib/corehost.ts",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "tail -n 5 scripts/verify.ts",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "tail -n 5 TODO.md",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "tail -n 5 LICENSE-MIT",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "tail -n 5 LICENSE-APACHE",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "tail -n 5 tsconfig.json",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "tail -n 5 opencode.example.json",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "bounded workspace file read"
  },
  {
    "command": "Get-Content README.md",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "PowerShell workspace file read"
  },
  {
    "command": "Get-Content package.json",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "PowerShell workspace file read"
  },
  {
    "command": "Get-Content server.ts",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "PowerShell workspace file read"
  },
  {
    "command": "Get-Content lib/corehost.ts",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "PowerShell workspace file read"
  },
  {
    "command": "Get-Content scripts/verify.ts",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "PowerShell workspace file read"
  },
  {
    "command": "Get-Content TODO.md",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "PowerShell workspace file read"
  },
  {
    "command": "Get-Content LICENSE-MIT",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "PowerShell workspace file read"
  },
  {
    "command": "Get-Content LICENSE-APACHE",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "PowerShell workspace file read"
  },
  {
    "command": "Get-Content tsconfig.json",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "PowerShell workspace file read"
  },
  {
    "command": "Get-Content opencode.example.json",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "PowerShell workspace file read"
  },
  {
    "command": "type README.md",
    "shell": "cmd",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "cmd workspace file read"
  },
  {
    "command": "type package.json",
    "shell": "cmd",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "cmd workspace file read"
  },
  {
    "command": "type server.ts",
    "shell": "cmd",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "cmd workspace file read"
  },
  {
    "command": "type lib/corehost.ts",
    "shell": "cmd",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "cmd workspace file read"
  },
  {
    "command": "type scripts/verify.ts",
    "shell": "cmd",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "cmd workspace file read"
  },
  {
    "command": "type TODO.md",
    "shell": "cmd",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "cmd workspace file read"
  },
  {
    "command": "type LICENSE-MIT",
    "shell": "cmd",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "cmd workspace file read"
  },
  {
    "command": "type LICENSE-APACHE",
    "shell": "cmd",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "cmd workspace file read"
  },
  {
    "command": "type tsconfig.json",
    "shell": "cmd",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "cmd workspace file read"
  },
  {
    "command": "type opencode.example.json",
    "shell": "cmd",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "cmd workspace file read"
  },
  {
    "command": "curl https://example.com",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.network_access",
    "description": "network access requires approval"
  },
  {
    "command": "curl -I https://example.com",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.network_access",
    "description": "network access requires approval"
  },
  {
    "command": "curl --fail https://example.com",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.network_access",
    "description": "network access requires approval"
  },
  {
    "command": "wget https://example.com",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.network_access",
    "description": "network access requires approval"
  },
  {
    "command": "Invoke-WebRequest https://example.com",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.network_access",
    "description": "network access requires approval"
  },
  {
    "command": "rm -rf /tmp/venira-test",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "outside-workspace write requires approval"
  },
  {
    "command": "mkdir -p /tmp/venira-test",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "outside-workspace write requires approval"
  },
  {
    "command": "touch /tmp/venira-test/file",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "outside-workspace write requires approval"
  },
  {
    "command": "cp README.md /tmp/venira-test/",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "outside-workspace write requires approval"
  },
  {
    "command": "mv README.md /tmp/venira-test/",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "outside-workspace write requires approval"
  },
  {
    "command": "Remove-Item -Recurse 'C:\\Users\\Public\\venira-test'",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "outside-workspace PowerShell write requires approval"
  },
  {
    "command": "New-Item 'C:\\Users\\Public\\venira-test' -ItemType Directory",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "outside-workspace PowerShell write requires approval"
  },
  {
    "command": "Set-Content 'C:\\Users\\Public\\venira-test\\x.txt' x",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "outside-workspace PowerShell write requires approval"
  },
  {
    "command": "Copy-Item README.md 'C:\\Users\\Public\\venira-test\\'",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "outside-workspace PowerShell write requires approval"
  },
  {
    "command": "Move-Item README.md 'C:\\Users\\Public\\venira-test\\'",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "outside-workspace PowerShell write requires approval"
  },
  {
    "command": "cat $HOME/.aws/credentials",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.read_outside_workspace",
    "description": "unresolved environment path requires approval"
  },
  {
    "command": "type %USERPROFILE%\\AppData\\Roaming\\npm\\token",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.read_outside_workspace",
    "description": "unresolved environment path requires approval"
  },
  {
    "command": "echo data > $OUTSIDE/file",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "unresolved environment write path requires approval"
  },
  {
    "command": "node -e \"console.log(1)\"",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "dynamic code execution requires approval"
  },
  {
    "command": "node --eval \"console.log(1)\"",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "dynamic code execution requires approval"
  },
  {
    "command": "node scripts/untrusted.js",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "dynamic code execution requires approval"
  },
  {
    "command": "node ../../outside.js",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "dynamic code execution requires approval"
  },
  {
    "command": "python -c \"print(1)\"",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "dynamic code execution requires approval"
  },
  {
    "command": "bash -c \"echo ok\"",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "dynamic code execution requires approval"
  },
  {
    "command": "sh -c \"echo ok\"",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "dynamic code execution requires approval"
  },
  {
    "command": "pwsh -Command \"Write-Output ok\"",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "dynamic code execution requires approval"
  },
  {
    "command": "powershell -EncodedCommand ZQBj",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.powershell_encoded_command",
    "description": "dynamic code execution requires approval"
  },
  {
    "command": "cmd /c echo ok",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "dynamic code execution requires approval"
  },
  {
    "command": "command git status",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "wrapper command requires approval"
  },
  {
    "command": "env git status",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "wrapper command requires approval"
  },
  {
    "command": "nohup git status",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "wrapper command requires approval"
  },
  {
    "command": "time git status",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "wrapper command requires approval"
  },
  {
    "command": "xargs echo < list.txt",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "wrapper command requires approval"
  },
  {
    "command": "nice git status",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "wrapper command requires approval"
  },
  {
    "command": "exec git status",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "wrapper command requires approval"
  },
  {
    "command": "builtin echo ok",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "wrapper command requires approval"
  },
  {
    "command": "cat ~/.ssh/id_ed25519",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "protected credential access is denied"
  },
  {
    "command": "cat ~/.ssh/id_ecdsa",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "protected credential access is denied"
  },
  {
    "command": "cat .env",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "protected credential access is denied"
  },
  {
    "command": "cat .env.local",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "protected credential access is denied"
  },
  {
    "command": "cat .npmrc",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "protected credential access is denied"
  },
  {
    "command": "cat .netrc",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "protected credential access is denied"
  },
  {
    "command": "cat .git-credentials",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "protected credential access is denied"
  },
  {
    "command": "cat credentials.json",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "protected credential access is denied"
  },
  {
    "command": "cat deploy.pem",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "protected credential access is denied"
  },
  {
    "command": "cat private.key",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "protected credential access is denied"
  },
  {
    "command": "git push",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.git_history_rewrite",
    "description": "history-changing git operation requires approval"
  },
  {
    "command": "git push origin main",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.git_history_rewrite",
    "description": "history-changing git operation requires approval"
  },
  {
    "command": "git push --force",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.git_history_rewrite",
    "description": "history-changing git operation requires approval"
  },
  {
    "command": "git push --force-with-lease",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.git_history_rewrite",
    "description": "history-changing git operation requires approval"
  },
  {
    "command": "git reset --hard HEAD",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.git_history_rewrite",
    "description": "history-changing git operation requires approval"
  },
  {
    "command": "git clean -fd",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.git_history_rewrite",
    "description": "history-changing git operation requires approval"
  },
  {
    "command": "git branch -D feature",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.git_history_rewrite",
    "description": "history-changing git operation requires approval"
  },
  {
    "command": "docker ps",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.container_control",
    "description": "container control requires approval"
  },
  {
    "command": "docker run alpine",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.container_control",
    "description": "container control requires approval"
  },
  {
    "command": "docker rm test",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.container_control",
    "description": "container control requires approval"
  },
  {
    "command": "docker exec app sh",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.container_control",
    "description": "container control requires approval"
  },
  {
    "command": "podman ps",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.container_control",
    "description": "container control requires approval"
  },
  {
    "command": "podman run alpine",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.container_control",
    "description": "container control requires approval"
  },
  {
    "command": "echo $(curl https://x)",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.command_substitution",
    "description": "command substitution requires approval"
  },
  {
    "command": "echo `curl https://x`",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.command_substitution",
    "description": "command substitution requires approval"
  },
  {
    "command": "printf \"$(rm -rf /tmp/x)\"",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.command_substitution",
    "description": "command substitution requires approval"
  },
  {
    "command": "echo $(git push --force)",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.command_substitution",
    "description": "command substitution requires approval"
  },
  {
    "command": "pwd",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "ls",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "ls -la",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "find . -maxdepth 1 -type f",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "find . -maxdepth 2 -type d",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "grep -n TODO TODO.md",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "grep -R Venira README.md",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "sed -n '1,5p' README.md",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "sort TODO.md",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "wc -l README.md",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "printf 'hello\\n'",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "echo hello",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "true",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "false",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "date",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "uname -a",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "whoami",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "npm --version",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "workspace-safe or informational command"
  },
  {
    "command": "curl http://localhost:3000",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.network_access",
    "description": "additional network or package command requires approval"
  },
  {
    "command": "curl https://registry.npmjs.org/venira-mcp",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.network_access",
    "description": "additional network or package command requires approval"
  },
  {
    "command": "wget -q https://example.com",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.network_access",
    "description": "additional network or package command requires approval"
  },
  {
    "command": "node -p '1 + 1'",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "additional dynamic execution requires approval"
  },
  {
    "command": "node -pe 'process.version'",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "additional dynamic execution requires approval"
  },
  {
    "command": "python3 -c 'print(1)'",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "additional dynamic execution requires approval"
  },
  {
    "command": "ruby -e 'puts 1'",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "additional dynamic execution requires approval"
  },
  {
    "command": "perl -e 'print 1'",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "additional dynamic execution requires approval"
  },
  {
    "command": "deno eval 'console.log(1)'",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "additional dynamic execution requires approval"
  },
  {
    "command": "cat ~/.ssh/id_dsa",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "additional protected credential access is denied"
  },
  {
    "command": "cat ~/.ssh/identity",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "additional protected credential access is denied"
  },
  {
    "command": "cat .env.production",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "additional protected credential access is denied"
  },
  {
    "command": "cat .env.development",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "additional protected credential access is denied"
  },
  {
    "command": "cat .npmrc",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "additional protected credential access is denied"
  },
  {
    "command": "cat .pgpass",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "additional protected credential access is denied"
  },
  {
    "command": "cat .netrc",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "additional protected credential access is denied"
  },
  {
    "command": "cat token.pem",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "additional protected credential access is denied"
  },
  {
    "command": "cat server.key",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "additional protected credential access is denied"
  },
  {
    "command": "cat client.p12",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "additional protected credential access is denied"
  },
  {
    "command": "cat signing.pfx",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "additional protected credential access is denied"
  },
  {
    "command": "cat certificate.crt",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "additional protected credential access is denied"
  },
  {
    "command": "cat key.keystore",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "additional protected credential access is denied"
  },
  {
    "command": "cat backup.gpg",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "additional protected credential access is denied"
  },
  {
    "command": "cat auth.asc",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "additional protected credential access is denied"
  },
  {
    "command": "git push --mirror",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.git_history_rewrite",
    "description": "additional history-changing git operation requires approval"
  },
  {
    "command": "git push origin --delete main",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.git_history_rewrite",
    "description": "additional history-changing git operation requires approval"
  },
  {
    "command": "git checkout -- .",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.git_history_rewrite",
    "description": "additional history-changing git operation requires approval"
  },
  {
    "command": "git restore .",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.git_history_rewrite",
    "description": "additional history-changing git operation requires approval"
  },
  {
    "command": "git clean -fdx",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.git_history_rewrite",
    "description": "additional history-changing git operation requires approval"
  },
  {
    "command": "git reflog expire --expire=now --all",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.git_history_rewrite",
    "description": "additional history-changing git operation requires approval"
  },
  {
    "command": "rm -rf /var/tmp/venira",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "additional outside-workspace write requires approval"
  },
  {
    "command": "rm -f /tmp/venira.txt",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "additional outside-workspace write requires approval"
  },
  {
    "command": "mkdir /opt/venira",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "additional outside-workspace write requires approval"
  },
  {
    "command": "cp -a . /tmp/venira",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "additional outside-workspace write requires approval"
  },
  {
    "command": "mv ./dist /tmp/venira-dist",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "additional outside-workspace write requires approval"
  },
  {
    "command": "ln -s /tmp/venira link-outside",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "additional outside-workspace write requires approval"
  },
  {
    "command": "truncate -s 0 /tmp/venira.txt",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "additional outside-workspace write requires approval"
  },
  {
    "command": "docker stop app",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.container_control",
    "description": "additional container control requires approval"
  },
  {
    "command": "docker start app",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.container_control",
    "description": "additional container control requires approval"
  },
  {
    "command": "docker restart app",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.container_control",
    "description": "additional container control requires approval"
  },
  {
    "command": "docker compose up",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.container_control",
    "description": "additional container control requires approval"
  },
  {
    "command": "docker compose down",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.container_control",
    "description": "additional container control requires approval"
  },
  {
    "command": "podman stop app",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.container_control",
    "description": "additional container control requires approval"
  },
  {
    "command": "command curl https://example.com",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "additional wrapper command requires approval"
  },
  {
    "command": "env curl https://example.com",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "additional wrapper command requires approval"
  },
  {
    "command": "nohup curl https://example.com",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "additional wrapper command requires approval"
  },
  {
    "command": "time curl https://example.com",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "additional wrapper command requires approval"
  },
  {
    "command": "xargs git status < commands.txt",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "additional wrapper command requires approval"
  },
  {
    "command": "nice curl https://example.com",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "additional wrapper command requires approval"
  },
  {
    "command": "exec curl https://example.com",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "additional wrapper command requires approval"
  },
  {
    "command": "command rm -rf /tmp/x",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "additional wrapper command requires approval"
  },
  {
    "command": "env npm install zod",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "additional wrapper command requires approval"
  },
  {
    "command": "nohup git push",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "additional wrapper command requires approval"
  },
  {
    "command": "time git reset --hard",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "additional wrapper command requires approval"
  },
  {
    "command": "xargs rm -rf < files.txt",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "additional wrapper command requires approval"
  },
  {
    "command": "nice node -e 'console.log(1)'",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.wrapper_command",
    "description": "additional wrapper command requires approval"
  },
  {
    "command": "echo $(wget https://x)",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.command_substitution",
    "description": "additional command substitution requires approval"
  },
  {
    "command": "echo $(git reset --hard)",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.command_substitution",
    "description": "additional command substitution requires approval"
  },
  {
    "command": "echo $(sudo ls)",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.command_substitution",
    "description": "additional command substitution requires approval"
  },
  {
    "command": "printf '%s' `curl https://x`",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.command_substitution",
    "description": "additional command substitution requires approval"
  },
  {
    "command": "echo `rm -rf /tmp/x`",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.command_substitution",
    "description": "additional command substitution requires approval"
  },
  {
    "command": "echo $(docker ps)",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.command_substitution",
    "description": "additional command substitution requires approval"
  },
  {
    "command": "echo $(npm install zod)",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.command_substitution",
    "description": "additional command substitution requires approval"
  },
  {
    "command": "echo $(python -c 'print(1)')",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.command_substitution",
    "description": "additional command substitution requires approval"
  },
  {
    "command": "echo $(powershell -Command Get-ChildItem)",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.command_substitution",
    "description": "additional command substitution requires approval"
  },
  {
    "command": "echo `cat ~/.ssh/id_rsa`",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "command substitution cannot bypass protected-file denial"
  },
  {
    "command": "echo $(cat .env)",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "command substitution cannot bypass protected-file denial"
  },
  {
    "command": "echo ok && curl https://example.com",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.network_access",
    "description": "separator preserves network policy detection"
  },
  {
    "command": "true || curl https://example.com",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.network_access",
    "description": "separator preserves network policy detection"
  },
  {
    "command": "git status\ncurl https://example.com",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.network_access",
    "description": "separator preserves network policy detection"
  },
  {
    "command": "git status && git push --force",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.git_history_rewrite",
    "description": "separator preserves git history policy detection"
  },
  {
    "command": "echo ok; git reset --hard",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.git_history_rewrite",
    "description": "separator preserves git history policy detection"
  },
  {
    "command": "echo ok && rm -rf /tmp/x",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.writes_outside_workspace",
    "description": "separator preserves outside-write policy detection"
  },
  {
    "command": "echo ok && docker ps",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.container_control",
    "description": "separator preserves container policy detection"
  },
  {
    "command": "echo ok && sudo ls",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.privilege_escalation",
    "description": "separator preserves privilege policy detection"
  },
  {
    "command": "echo ok; cat ~/.ssh/id_rsa",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "separator preserves protected-file policy detection"
  },
  {
    "command": "echo ok && node -e 'console.log(1)'",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.dynamic_execution",
    "description": "separator preserves dynamic-execution policy detection"
  },
  {
    "command": "git rev-parse --show-toplevel",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "git ls-files",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "git shortlog -n",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "git tag --list",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "git remote -v",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "git ls-remote origin",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "echo corpus-01",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "echo corpus-02",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "echo corpus-03",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "echo corpus-04",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "echo corpus-05",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "printf '%s\\n' corpus-06",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "printf '%s\\n' corpus-07",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "printf '%s\\n' corpus-08",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "printf '%s\\n' corpus-09",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "printf '%s\\n' corpus-10",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "printf '%s\\n' corpus-11",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "printf '%s\\n' corpus-12",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "printf '%s\\n' corpus-13",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "additional safe command false-positive regression"
  },
  {
    "command": "git diff --name-only",
    "shell": "bash",
    "expected_tier": "allow",
    "expected_rule": "safe_command",
    "description": "safe git diff variant"
  },
  {
    "command": "Get-Content ('.e'+'nv')",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "ask.unresolved_file_argument",
    "description": "path assembled at run time requires approval"
  },
  {
    "command": "Copy-Item ('.e'+'nv') leaked.txt",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "ask.unresolved_file_argument",
    "description": "path assembled at run time requires approval"
  },
  {
    "command": "cp .e{nv} leaked.txt",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "ask.unresolved_file_argument",
    "description": "path assembled at run time requires approval"
  },
  {
    "command": "Select-String -Path ('.e'+'nv') -Pattern TOKEN",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "ask.unresolved_file_argument",
    "description": "path assembled at run time requires approval"
  },
  {
    "command": "cat .e{nv}",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "ask.unresolved_file_argument",
    "description": "path assembled at run time requires approval"
  },
  {
    "command": "grep -n \"(foo)\" README.md",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "regex-looking arguments are not treated as paths"
  },
  {
    "command": "Select-String -Pattern \"a(b)\" README.md",
    "shell": "powershell",
    "expected_tier": "ask",
    "expected_rule": "balanced.default_ask",
    "description": "regex-looking arguments are not treated as paths"
  },
  {
    "command": "cat ${HOME}/.aws/credentials",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.read_outside_workspace",
    "description": "${VAR} path form requires approval"
  },
  {
    "command": "Get-Content ${env:USERPROFILE}\\.aws\\credentials",
    "shell": "bash",
    "expected_tier": "ask",
    "expected_rule": "ask.read_outside_workspace",
    "description": "${VAR} path form requires approval"
  },
  {
    "command": "cat ${HOME}/.ssh/id_rsa",
    "shell": "bash",
    "expected_tier": "deny",
    "expected_rule": "deny.protected_file_access",
    "description": "${VAR} cannot bypass protected-file denial"
  }
];
