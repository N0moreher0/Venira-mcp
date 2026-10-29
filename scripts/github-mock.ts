/**
 * In-process GitHub API mock for `npm run verify` (and for the manual e2e).
 *
 * It implements exactly the endpoints the coding tools use, so the whole
 * provider surface (PR create/comment/merge, Actions status/dispatch/logs,
 * error mapping and redirect auth-dropping) is exercised without a real token,
 * without network access and without rate limits.
 *
 * The log download is deliberately served from a *different origin* (a second
 * localhost port) so the test can assert that the `Authorization` header is
 * dropped on the redirect GitHub uses for pre-signed blob URLs.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { deflateRawSync } from "node:zlib";

export type MockRequest = { method: string; path: string; auth: string | null };

export type GithubMock = {
  apiUrl: string;
  blobUrl: string;
  requests: MockRequest[];
  /** Authorization header seen by the blob (log download) server. */
  blobAuth: Array<string | null>;
  state: { dispatches: number; comments: number; merges: number; branchDeletes: number; pullsCreated: number; inlineComments: number; lastInline: any };
  close: () => Promise<void>;
};

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer — stored or deflated entries, as GitHub's archives use. */
export function zipStored(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const method = entry.deflate ? 8 : 0;
    const payload = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, payload);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, eocd]);
}

const RUN = {
  id: 99,
  name: "CI",
  run_number: 12,
  status: "completed",
  conclusion: "failure",
  event: "push",
  head_branch: "verify-branch",
  head_sha: "0123456789abcdef0123456789abcdef01234567",
  created_at: "2026-10-29T02:00:00Z",
  updated_at: "2026-10-29T02:04:00Z",
  html_url: "https://github.com/acme/demo/actions/runs/99",
  run_attempt: 1,
};

const RUNS = [
  RUN,
  {
    ...RUN,
    id: 98,
    run_number: 11,
    conclusion: "success",
    head_branch: "main",
    html_url: "https://github.com/acme/demo/actions/runs/98",
  },
];

const JOBS = [
  { id: 1, name: "build", status: "completed", conclusion: "success", started_at: "2026-10-29T02:00:05Z", completed_at: "2026-10-29T02:02:00Z", html_url: "https://github.com/acme/demo/runs/1", runner_name: "ubuntu-latest" },
  { id: 2, name: "test", status: "completed", conclusion: "failure", started_at: "2026-10-29T02:02:05Z", completed_at: "2026-10-29T02:04:00Z", html_url: "https://github.com/acme/demo/runs/2", runner_name: "ubuntu-latest" },
];

/** Branch-protection check-runs (one passing, one failing). */
const CHECK_RUNS = [
  {
    id: 501,
    name: "build",
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-29T02:00:05Z",
    completed_at: "2026-10-29T02:02:00Z",
    html_url: "https://github.com/acme/demo/runs/501",
    app: { name: "GitHub Actions" },
    output: { title: "ok" },
  },
  {
    id: 502,
    name: "lint",
    status: "completed",
    conclusion: "failure",
    started_at: "2026-10-29T02:02:05Z",
    completed_at: "2026-10-29T02:03:00Z",
    html_url: "https://github.com/acme/demo/runs/502",
    app: { name: "GitHub Actions" },
    output: { title: "3 warnings" },
  },
];

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

export async function startGithubMock(): Promise<GithubMock> {
  const requests: MockRequest[] = [];
  const blobAuth: Array<string | null> = [];
  const state = { dispatches: 0, comments: 0, merges: 0, branchDeletes: 0, pullsCreated: 0, inlineComments: 0, lastInline: null as any };

  let blobUrl = "";

  const logZip = zipStored([
    {
      name: "build/1_build.txt",
      data: Buffer.from(
        Array.from({ length: 20 }, (_, i) => `build step ${i}: ok`).join("\n") + "\nBUILD finished\n",
      ),
    },
    {
      name: "test/2_test.txt",
      // Deflated, like real GitHub log archives (exercises inflateRawSync).
      deflate: true,
      data: Buffer.from(
        Array.from({ length: 10 }, (_, i) => `test line ${i}`).join("\n") +
          "\nFAIL src/demo.test.ts:42: expected 1 to be 2\nTest run finished with 1 failed\n",
      ),
    },
  ]);
  const jobText = Buffer.from(
    Array.from({ length: 30 }, (_, i) => `job step ${i}`).join("\n") + "\nFAIL demo.test.ts:42\n",
  );

  // Blob server: a *different origin*, like GitHub's pre-signed storage URL.
  const blobServer = http.createServer((req, res) => {
    blobAuth.push((req.headers.authorization as string | undefined) ?? null);
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/logs.zip") {
      res.writeHead(200, { "content-type": "application/zip", "content-length": String(logZip.length) });
      res.end(logZip);
      return;
    }
    if (path === "/job.log") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(jobText);
      return;
    }
    res.writeHead(404).end("not found");
  });
  blobUrl = await listen(blobServer);

  const apiServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    requests.push({ method: req.method ?? "", path: path + url.search, auth: (req.headers.authorization as string | undefined) ?? null });

    const json = (status: number, body: unknown) => {
      const payload = Buffer.from(JSON.stringify(body), "utf8");
      res.writeHead(status, {
        "content-type": "application/json",
        "content-length": String(payload.length),
        "x-ratelimit-remaining": "999",
      });
      res.end(payload);
    };
    const empty = (status: number) => {
      res.writeHead(status, { "x-ratelimit-remaining": "999" });
      res.end();
    };
    const readBody = (): Promise<any> =>
      new Promise((resolve) => {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk.toString("utf8");
        });
        req.on("end", () => {
          try {
            resolve(raw ? JSON.parse(raw) : {});
          } catch {
            resolve({});
          }
        });
      });

    const handle = async (): Promise<void> => {
      const base = "/repos/acme/demo";

      if (path === base && req.method === "GET") return json(200, { full_name: "acme/demo", default_branch: "main", private: false });

      if (path === `${base}/pulls` && req.method === "POST") {
        const body = await readBody();
        state.pullsCreated += 1;
        return json(201, {
          number: 7,
          html_url: "https://github.com/acme/demo/pull/7",
          url: `${url.origin}${base}/pulls/7`,
          title: body.title,
          state: "open",
          draft: body.draft === true,
          head: { ref: body.head },
          base: { ref: body.base },
        });
      }

      if (path === `${base}/pulls/7` && req.method === "GET") {
        return json(200, {
          number: 7,
          state: "open",
          merged: false,
          mergeable: true,
          title: "Add provider tools",
          head: { ref: "verify-branch", sha: "0123456789abcdef0123456789abcdef01234567", repo: { full_name: "acme/demo" } },
          base: { ref: "main" },
        });
      }

      if (path === `${base}/pulls/999` && req.method === "GET") return json(404, { message: "Not Found" });

      if (path === `${base}/pulls/7/merge` && req.method === "PUT") {
        state.merges += 1;
        return json(200, { merged: true, sha: "sha-merge", message: "Pull Request successfully merged" });
      }

      if (/^\/repos\/acme\/demo\/issues\/7\/comments$/u.test(path) && req.method === "POST") {
        state.comments += 1;
        return json(201, {
          id: 1000 + state.comments,
          html_url: `https://github.com/acme/demo/pull/7#issuecomment-${1000 + state.comments}`,
          created_at: "2026-10-29T02:10:00Z",
        });
      }

      // Inline review comments: pinned to a file/line in the "Files changed" tab.
      if (/^\/repos\/acme\/demo\/pulls\/7\/comments$/u.test(path) && req.method === "POST") {
        const body = await readBody();
        state.inlineComments += 1;
        state.lastInline = body;
        return json(201, {
          id: 2000 + state.inlineComments,
          html_url: `https://github.com/acme/demo/pull/7#discussion_r${2000 + state.inlineComments}`,
          created_at: "2026-10-29T02:11:00Z",
        });
      }

      // Branch-protection checks (check-runs API).
      if (/^\/repos\/acme\/demo\/commits\/.+\/check-runs$/u.test(path) && req.method === "GET") {
        return json(200, {
          total_count: CHECK_RUNS.length,
          check_runs: CHECK_RUNS,
        });
      }

      if (path === `${base}/git/refs/heads/verify-branch` && req.method === "DELETE") {
        state.branchDeletes += 1;
        return empty(204);
      }

      if (path === `${base}/actions/runs` && req.method === "GET") {
        const branch = url.searchParams.get("branch");
        const filtered = branch ? RUNS.filter((run) => run.head_branch === branch) : RUNS;
        return json(200, { total_count: filtered.length, workflow_runs: filtered });
      }

      if (/^\/repos\/acme\/demo\/actions\/workflows\/ci\.yml\/runs$/u.test(path) && req.method === "GET") {
        return json(200, { total_count: RUNS.length, workflow_runs: RUNS });
      }

      if (path === `${base}/actions/runs/99` && req.method === "GET") return json(200, RUN);

      if (path === `${base}/actions/runs/99/jobs` && req.method === "GET") {
        return json(200, { total_count: JOBS.length, jobs: JOBS });
      }

      if (path === `${base}/actions/runs/99/logs` && req.method === "GET") {
        res.writeHead(302, { location: `${blobUrl}/logs.zip` });
        res.end();
        return;
      }

      if (path === `${base}/actions/jobs/1/logs` && req.method === "GET") {
        res.writeHead(302, { location: `${blobUrl}/job.log` });
        res.end();
        return;
      }

      if (/^\/repos\/acme\/demo\/actions\/workflows\/ci\.yml\/dispatches$/u.test(path) && req.method === "POST") {
        state.dispatches += 1;
        return empty(204);
      }

      return json(404, { message: `mock: no route for ${req.method} ${path}` });
    };

    void handle().catch((error: unknown) => {
      json(500, { message: error instanceof Error ? error.message : String(error) });
    });
  });

  const apiUrl = await listen(apiServer);

  return {
    apiUrl,
    blobUrl,
    requests,
    blobAuth,
    state,
    close: async () => {
      await Promise.all([
        new Promise<void>((resolve) => apiServer.close(() => resolve())),
        new Promise<void>((resolve) => blobServer.close(() => resolve())),
      ]);
    },
  };
}
