/** Verify section module: secrets. Behaviour is unchanged from the original scripts/verify.ts. */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Harness } from "./harness.js";
import type { runShellPolicy } from "./shell-policy.js";

export async function runSecrets(
  $h: Harness,
  $prior: Awaited<ReturnType<typeof runShellPolicy>>,
) {
  const { verifyDataDir, call, check, dir } = $h;
  const { shellFor, asEnvelope, runWithCliApproval } = $prior;
  // 11c. Secrets: encrypted store, metadata-only reads, env-gated reveal.
  console.log("[verify] checking secrets...");
  const SECRET_NAME = "VERIFY_TOKEN";
  const SECRET_VALUE = "verify-secret-value-9f3a1b2c";
  const secretSet = asEnvelope(
    await call("project_secret", {
      action: "set",
      name: SECRET_NAME,
      value: SECRET_VALUE,
    }),
  );
  check(
    "secret_set",
    secretSet.ok === true &&
      secretSet.kind === "secret" &&
      secretSet.data?.action === "set" &&
      secretSet.data?.length === Buffer.byteLength(SECRET_VALUE),
    secretSet,
  );
  check(
    "secret_set_value_not_returned",
    !JSON.stringify(secretSet).includes(SECRET_VALUE),
    secretSet,
  );

  const secretGet = asEnvelope(
    await call("project_secret", { action: "get", name: SECRET_NAME }),
  );
  check(
    "secret_get_metadata_only",
    secretGet.ok === true &&
      secretGet.data?.revealed === false &&
      typeof secretGet.data?.sha256_12 === "string" &&
      !("value" in (secretGet.data ?? {})) &&
      !JSON.stringify(secretGet).includes(SECRET_VALUE),
    secretGet,
  );
  const secretReveal = asEnvelope(
    await call("project_secret", {
      action: "get",
      name: SECRET_NAME,
      reveal: 1,
    }),
  );
  check(
    "secret_reveal_gated",
    secretReveal.error?.code === "feature_disabled",
    secretReveal,
  );
  const installSelfOff = asEnvelope(
    await call("project_install_self", { harness: "opencode" }),
  );
  check(
    "install_self_feature_disabled",
    installSelfOff.error?.code === "feature_disabled",
    installSelfOff,
  );

  const secretList = asEnvelope(
    await call("project_secret", { action: "list" }),
  );
  check(
    "secret_list_names_only",
    secretList.ok === true &&
      (secretList.data?.secrets ?? []).some(
        (s: { name?: string }) => s.name === SECRET_NAME,
      ) &&
      !JSON.stringify(secretList).includes(SECRET_VALUE),
    secretList.data,
  );

  const secretDenied = asEnvelope(
    await call("project_secret", {
      action: "set",
      name: "NODE_OPTIONS",
      value: "--require=/tmp/evil.js",
    }),
  );
  check(
    "secret_dangerous_name_denied",
    secretDenied.error?.code === "invalid_request",
    secretDenied,
  );

  const secretFile = path.resolve(
    process.env.VENIRA_DATA_DIR ?? path.join(process.cwd(), "data"),
    "secrets.json",
  );
  const secretRaw = await fs.readFile(secretFile, "utf8").catch(() => "");
  check(
    "secret_encrypted_at_rest",
    secretRaw.includes(SECRET_NAME) &&
      !secretRaw.includes(SECRET_VALUE) &&
      secretRaw.includes('"iv"'),
    { bytes: secretRaw.length, has_name: secretRaw.includes(SECRET_NAME) },
  );

  const secretsModule = await import("../../lib/secrets.js");
  const redactionUnit = secretsModule.redactSecretValues(
    `fallback ${SECRET_VALUE} fallback`,
  );
  check(
    "secret_redaction_unit",
    redactionUnit === "fallback [REDACTED] fallback",
    redactionUnit,
  );

  // 11c-bis. Hash/crypto hardening: keyed fingerprint, AAD-bound ciphertext,
  // atomic+locked key creation, and read-modify-write safety.
  const keyfileModule = await import("../../lib/keyfile.js");
  const approvalKeyFile = path.join(verifyDataDir, "approval.key");
  const approvalKeyRaw = await fs
    .readFile(approvalKeyFile, "utf8")
    .catch(() => "");
  check(
    "approval_key_is_32_byte_hex",
    /^[0-9a-f]{64}$/.test(approvalKeyRaw.trim()),
    approvalKeyRaw.trim().length,
  );
  const unitKeyFile = path.join(verifyDataDir, "unit-keyfile.key");
  const unitKey1 = keyfileModule.readOrCreateHexKey(unitKeyFile, "unit");
  await fs.writeFile(unitKeyFile, "abcd");
  let invalidKeyMessage = "";
  try {
    keyfileModule.readHexKey(unitKeyFile, "unit");
  } catch (error) {
    invalidKeyMessage = error instanceof Error ? error.message : String(error);
  }
  check(
    "keyfile_rejects_short_key",
    invalidKeyMessage.includes("unit_key_invalid"),
    invalidKeyMessage,
  );
  await fs.writeFile(unitKeyFile, unitKey1.toString("hex"));
  const unitKey2 = keyfileModule.readOrCreateHexKey(unitKeyFile, "unit");
  check("keyfile_is_stable", unitKey1.equals(unitKey2));

  const plainDigest = (await import("node:crypto"))
    .createHash("sha256")
    .update(SECRET_VALUE, "utf8")
    .digest("hex");
  await call("project_secret", {
    action: "set",
    name: SECRET_NAME,
    value: SECRET_VALUE,
  });
  const storeAfterSet = JSON.parse(await fs.readFile(secretFile, "utf8")) as {
    secrets: Record<
      string,
      {
        v?: number;
        sha256?: string;
        fingerprint?: string;
        iv: string;
        tag: string;
        data: string;
      }
    >;
  };
  check(
    "secret_store_no_plaintext_digest",
    !(await fs.readFile(secretFile, "utf8")).includes(plainDigest),
    { digest: plainDigest.slice(0, 12) },
  );
  check(
    "secret_store_hmac_fingerprint",
    storeAfterSet.secrets[SECRET_NAME]?.v === 2 &&
      typeof storeAfterSet.secrets[SECRET_NAME]?.fingerprint === "string" &&
      storeAfterSet.secrets[SECRET_NAME]?.sha256 === undefined,
    storeAfterSet.secrets[SECRET_NAME],
  );

  const SWAP_NAME = "VERIFY_TOKEN_SWAP";
  const SWAP_VALUE = "swap-secret-value-71bd";
  await secretsModule.setSecret(SWAP_NAME, SWAP_VALUE);
  const swappable = JSON.parse(await fs.readFile(secretFile, "utf8")) as {
    secrets: Record<string, { iv: string; tag: string; data: string }>;
  };
  const target = swappable.secrets[SECRET_NAME];
  const source = swappable.secrets[SWAP_NAME];
  swappable.secrets[SECRET_NAME] = {
    ...target,
    iv: source.iv,
    tag: source.tag,
    data: source.data,
  };
  swappable.secrets[SWAP_NAME] = {
    ...source,
    iv: target.iv,
    tag: target.tag,
    data: target.data,
  };
  await fs.writeFile(secretFile, JSON.stringify(swappable));
  const swappedValue = secretsModule.getSecretValueSync(SECRET_NAME);
  check(
    "secret_ciphertext_swap_detected",
    swappedValue !== SWAP_VALUE && swappedValue !== SECRET_VALUE,
    { got: swappedValue === undefined ? "undefined" : "other-secret" },
  );
  await secretsModule.setSecret(SECRET_NAME, SECRET_VALUE);
  await secretsModule.deleteSecret(SWAP_NAME);
  check(
    "secret_ciphertext_restored",
    secretsModule.getSecretValueSync(SECRET_NAME) === SECRET_VALUE,
  );

  const raceNames = Array.from({ length: 5 }, (_, i) => `VERIFY_RACE_${i}`);
  await Promise.all(
    raceNames.map((raceName, i) =>
      secretsModule.setSecret(raceName, `race-value-${i}-xyz`),
    ),
  );
  const raceStored = secretsModule.listSecrets().map((entry) => entry.name);
  check(
    "secret_concurrent_sets_keep_all_rows",
    raceNames.every((raceName) => raceStored.includes(raceName)),
    {
      expected: raceNames,
      stored: raceStored.filter((name) => name.startsWith("VERIFY_RACE_")),
    },
  );
  await Promise.all(
    raceNames.map((raceName) => secretsModule.deleteSecret(raceName)),
  );

  // secret_env injects the value into the child, and every returned tail is scrubbed.
  const secretInjectionAsk = asEnvelope(
    await call("project_shell_run", {
      command: "echo hi",
      shell: shellFor,
      secret_env: [SECRET_NAME],
    }),
  );
  check(
    "secret_env_requires_approval",
    secretInjectionAsk.error?.code === "approval_required" &&
      secretInjectionAsk.data?.rule === "ask.secret_env_injection",
    secretInjectionAsk,
  );
  await fs.writeFile(
    `${dir}/leak-check.js`,
    `console.log('LEAK:' + process.env.${SECRET_NAME});\n`,
  );
  const injected = asEnvelope(
    await runWithCliApproval((args) => call("project_shell_run", args), {
      command: `node ${dir}/leak-check.js`,
      shell: shellFor,
      secret_env: [SECRET_NAME],
    }),
  );
  const injectedRunId = String(injected.data?.run_id ?? "");
  let injectedStatus: Record<string, any> = {};
  for (let i = 0; i < 45; i++) {
    injectedStatus = asEnvelope(
      await call("project_shell_status", {
        run_id: injectedRunId,
        wait_seconds: 2,
      }),
    );
    if (!injectedStatus?.data?.running) break;
  }
  const injectedTail = String(injectedStatus?.data?.stdout_tail ?? "");
  check(
    "secret_env_injected_and_redacted",
    injectedStatus?.data?.running === false &&
      injectedTail.includes("LEAK:[REDACTED]") &&
      !JSON.stringify(injectedStatus).includes(SECRET_VALUE),
    injectedTail.slice(0, 120),
  );

  const missingSecret = asEnvelope(
    await call("project_shell_run", {
      command: "echo hi",
      shell: shellFor,
      secret_env: ["NOT_STORED_XYZ"],
    }),
  );
  check(
    "secret_env_missing",
    missingSecret.error?.code === "secret_missing",
    missingSecret,
  );

  // 11c-bis. Rotation metadata: expiry, last use, use count, expired refusal.
  const usedMeta = asEnvelope(
    await call("project_secret", { action: "get", name: SECRET_NAME }),
  );
  check(
    "secret_use_tracking",
    usedMeta.ok === true &&
      usedMeta.data?.use_count >= 1 &&
      typeof usedMeta.data?.last_used_at === "number",
    {
      use_count: usedMeta.data?.use_count,
      last_used_at: usedMeta.data?.last_used_at,
    },
  );

  const rotated = asEnvelope(
    await call("project_secret", {
      action: "set",
      name: SECRET_NAME,
      value: SECRET_VALUE,
      expires_in_days: 30,
    }),
  );
  check(
    "secret_rotation_metadata",
    rotated.ok === true &&
      rotated.data?.rotated === true &&
      typeof rotated.data?.expires_at === "number" &&
      rotated.data?.days_left >= 29 &&
      rotated.data?.use_count === 0 &&
      rotated.data?.last_used_at === null,
    rotated.data,
  );
  check(
    "secret_rotation_resets_use",
    rotated.data?.use_count === 0 && rotated.data?.last_used_at === null,
    rotated.data,
  );

  const EXPIRED_NAME = "VERIFY_EXPIRED";
  const expiredSet = asEnvelope(
    await call("project_secret", {
      action: "set",
      name: EXPIRED_NAME,
      value: "expired-secret-value-77aa",
      expires_at: Date.now() - 60_000,
    }),
  );
  check(
    "secret_expiry_stored",
    expiredSet.ok === true &&
      expiredSet.data?.expired === true &&
      expiredSet.data?.days_left < 0,
    expiredSet.data,
  );
  const expiredInjection = asEnvelope(
    await call("project_shell_run", {
      command: "echo hi",
      shell: shellFor,
      secret_env: [EXPIRED_NAME],
    }),
  );
  check(
    "secret_expired_refused",
    expiredInjection.error?.code === "secret_expired",
    expiredInjection,
  );
  const expiredGet = asEnvelope(
    await call("project_secret", { action: "get", name: EXPIRED_NAME }),
  );
  check(
    "secret_expired_get_hint",
    expiredGet.ok === true && expiredGet.data?.expired === true,
    expiredGet.data,
  );
  const expiryConflict = asEnvelope(
    await call("project_secret", {
      action: "set",
      name: EXPIRED_NAME,
      value: "x",
      expires_in_days: 1,
      expires_at: 1000,
    }),
  );
  check(
    "secret_expiry_conflict",
    expiryConflict.error?.code === "invalid_request",
    expiryConflict,
  );
  await call("project_secret", { action: "delete", name: EXPIRED_NAME });
  return { target, SECRET_NAME, SECRET_VALUE, source };
}
