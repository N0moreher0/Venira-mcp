import { createInterface } from "node:readline/promises";
import { listSecrets, setSecret } from "../lib/secrets.js";
import { activeDataDir } from "../lib/workspace.js";

if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
  console.error("GitHub token setup requires an interactive terminal.");
  process.exit(3);
}

function readHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = [...value].slice(0, -1).join("");
        } else if (char >= " ") {
          value += char;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function confirmOverwrite(): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("A GitHub token is already saved. Replace it? [y/N] ");
    return answer.trim().toLowerCase() === "y";
  } finally {
    prompt.close();
  }
}

try {
  const alreadyConfigured = listSecrets().some((secret) => secret.name === "GITHUB_TOKEN");
  if (alreadyConfigured && !(await confirmOverwrite())) {
    console.log("Kept the existing GitHub token.");
  } else {
    const token = await readHidden("GitHub token (input hidden): ");
    if (!token.trim()) throw new Error("Token cannot be empty.");
    const confirmation = await readHidden("Confirm GitHub token: ");
    if (token !== confirmation) throw new Error("The token entries did not match.");

    const meta = await setSecret("GITHUB_TOKEN", token.trim(), { source: "provider" });
    console.log(
      `${meta.created ? "Saved" : "Updated"} GitHub token in the encrypted Venira vault.\n` +
        `Shared local data directory: ${activeDataDir()}\n` +
        "Venira clients running as this OS user will use it automatically.",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
