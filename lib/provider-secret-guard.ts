import { lintSource } from "@secretlint/core";
import { creator as gitlabRule } from "@secretlint/secretlint-rule-gitlab";
import { creator as recommendedRules } from "@secretlint/secretlint-rule-preset-recommend";
import { getSecretValueSync, listSecrets } from "./secrets.js";

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_FIELDS = 2_048;
const MAX_DEPTH = 16;
const SENSITIVE_ENV_NAME =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTHORIZATION|ACCESS[_-]?KEY|(?:DATABASE|DB|REDIS|MONGO|MYSQL|POSTGRES(?:QL)?)[_-]?(?:URL|URI|DSN|CONNECTION[_-]?STRING)|CONNECTION[_-]?(?:STRING|URI)|\bDSN\b)/i;

type FieldValue = { field: string; value: string };
type ScanDirection = "request" | "response";

function collectStrings(value: unknown, fields: FieldValue[], field: string, depth: number, ancestors: Set<object>): void {
  if (typeof value === "string") {
    fields.push({ field, value });
    if (fields.length > MAX_FIELDS) {
      throw new Error("[secret_scan_limit] Too many text fields to scan safely.");
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (depth >= MAX_DEPTH || ancestors.has(value)) {
    throw new Error("[secret_scan_limit] Provider payload is too deeply nested or circular to scan safely.");
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, fields, field, depth + 1, ancestors);
  } else {
    for (const [key, nested] of Object.entries(value)) {
      collectStrings(nested, fields, depth === 0 ? key : field, depth + 1, ancestors);
    }
  }
  ancestors.delete(value);
}

function configuredSecretValues(): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (SENSITIVE_ENV_NAME.test(name) && typeof value === "string" && value.length >= 8) {
      values.add(value);
    }
  }
  for (const entry of listSecrets()) {
    const value = getSecretValueSync(entry.name);
    if (value && value.length >= 8) values.add(value);
  }
  return [...values];
}

function secretVariants(secret: string): string[] {
  const variants = [secret];
  if (secret.length >= 8) {
    variants.push(Buffer.from(secret, "utf8").toString("base64"));
    variants.push(encodeURIComponent(secret));
  }
  return variants;
}

function blockedError(
  direction: ScanDirection,
  operation: string,
  findings: Array<{ field: string; rule: string }>,
): Error {
  const summary = [...new Map(findings.map((item) => [`${item.field}\u0000${item.rule}`, item])).values()]
    .slice(0, 8)
    .map(({ field, rule }) => `field "${field}" (${rule})`)
    .join(", ");
  if (direction === "request") {
    return new Error(
      `[secret_detected] Blocked ${operation} before sending it to the Git provider: credential-like content found in ${summary}. ` +
        "No provider request was sent. Remove the credential from the input and rotate it if it is real; never paste it into chat.",
    );
  }
  return new Error(
    `[secret_output_blocked] Withheld the ${operation} response from the AI because credential-like content was detected in ${summary}. ` +
      "The provider operation may already have completed; do not retry a mutation. Review the provider directly and rotate any exposed credential.",
  );
}

export async function assertProviderPayloadSafe(
  value: unknown,
  options: { operation: string; direction: ScanDirection },
): Promise<void> {
  const fields: FieldValue[] = [];
  collectStrings(value, fields, "request", 0, new Set());

  const source = fields.map(({ field, value: text }) => `${JSON.stringify(field)}=${JSON.stringify(text)}`).join("\n");
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error(
      `[secret_scan_limit] Blocked ${options.operation}: provider content exceeds the ${MAX_SOURCE_BYTES}-byte secret-scan limit.`,
    );
  }

  try {
    const knownValues = configuredSecretValues();
    const findings: Array<{ field: string; rule: string }> = [];
    const knownVariants = knownValues.flatMap(secretVariants);
    for (const item of fields) {
      if (knownVariants.some((secret) => item.value.includes(secret))) {
        findings.push({ field: item.field, rule: "configured credential value" });
      }
    }

    if (source) {
      const result = await lintSource({
        source: { content: source, filePath: "provider-payload.txt", contentType: "text" },
        options: {
          config: {
            rules: [
              {
                id: recommendedRules.meta.id,
                rule: recommendedRules,
                rules: [{ id: "@secretlint/secretlint-rule-filter-comments", disabled: true }],
              },
              { id: "@secretlint/secretlint-rule-gitlab", rule: gitlabRule },
            ],
          },
          noPhysicFilePath: true,
          maskSecrets: true,
        },
      });
      for (const message of result.messages) {
        const field = fields[message.loc.start.line - 1]?.field ?? "request";
        findings.push({
          field,
          rule: message.ruleId,
        });
      }
    }

    if (findings.length > 0) throw blockedError(options.direction, options.operation, findings);
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("[secret_detected]") || error.message.startsWith("[secret_output_blocked]"))) {
      throw error;
    }
    if (error instanceof Error && error.message.startsWith("[secret_scan_limit]")) throw error;
    throw new Error(
      `[secret_scan_failed] Blocked ${options.operation}: the local secret scanner failed, so the content was not allowed to continue.`,
    );
  }
}
