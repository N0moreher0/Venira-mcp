/**
 * In-process GitLab + Bitbucket API mocks for `npm run verify`.
 *
 * They implement exactly the endpoints the dialects call, so provider routing,
 * auth headers, payload mapping and status normalisation are exercised without
 * a real account, network access or rate limits.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
type Seen = {
  method: string;
  path: string;
  auth: string | null;
  privateToken: string | null;
};
function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
function helpers(req: http.IncomingMessage, res: http.ServerResponse) {
  const json = (status: number, body: unknown) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": String(payload.length),
      ...(res.getHeaders() as Record<string, string | number | string[]>),
    });
    res.end(payload);
  };
  const text = (
    status: number,
    body: string,
    type = "text/plain; charset=utf-8",
  ) => {
    const payload = Buffer.from(body, "utf8");
    res.writeHead(status, {
      "content-type": type,
      "content-length": String(payload.length),
    });
    res.end(payload);
  };
  const empty = (status: number) => {
    res.writeHead(status);
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
  return { json, text, readBody, empty };
}
/** One-shot failure injected into the next matching `/pipelines` request (verify-only fault injection). */
export type MockFault = {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** How many matching requests still receive the fault. */
  remaining: number;
  /** Restrict to one HTTP method (default: any). */
  method?: string;
};
export type GitlabMock = {
  apiUrl: string;
  requests: Seen[];
  state: {
    comments: number;
    inline: number;
    merges: number;
    triggers: number;
    closes: number;
    reopens: number;
    ciCancels: number;
    ciRetries: number;
    lastInline: any;
    fault: MockFault | null;
  };
  close: () => Promise<void>;
};
export async function startGitlabMock(): Promise<GitlabMock> {
  const requests: Seen[] = [];
  const state = {
    comments: 0,
    inline: 0,
    merges: 0,
    triggers: 0,
    closes: 0,
    reopens: 0,
    ciCancels: 0,
    ciRetries: 0,
    lastInline: null as any,
    fault: null as MockFault | null,
  };
  const project = "/api/v4/projects/acme%2Fdemo";
  const mr = {
    iid: 11,
    state: "opened",
    title: "Add GitLab dialect",
    source_branch: "verify-branch",
    target_branch: "main",
    web_url: "https://gitlab.example/acme/demo/-/merge_requests/11",
    diff_refs: {
      base_sha: "base-sha",
      start_sha: "start-sha",
      head_sha: "head-sha",
    },
    detailed_merge_status: "mergeable",
    author: { username: "verifier" },
    created_at: "2026-10-29T03:00:00Z",
    updated_at: "2026-10-29T03:01:00Z",
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    requests.push({
      method: req.method ?? "",
      path: path + url.search,
      auth: (req.headers.authorization as string | undefined) ?? null,
      privateToken:
        (req.headers["private-token"] as string | undefined) ?? null,
    });
    const { json, text, readBody } = helpers(req, res);
    const handle = async () => {
      if (
        state.fault &&
        state.fault.remaining > 0 &&
        path.includes("/pipelines") &&
        (!state.fault.method || state.fault.method === req.method)
      ) {
        state.fault.remaining -= 1;
        for (const [name, value] of Object.entries(state.fault.headers ?? {})) res.setHeader(name, value);
        return json(state.fault.status, state.fault.body ?? { message: `injected ${state.fault.status}` });
      }
      if (path === project && req.method === "GET")
        return json(200, { default_branch: "main" });
      if (path === `${project}/merge_requests` && req.method === "POST") {
        const body = await readBody();
        return json(201, {
          ...mr,
          iid: 11,
          title: body.title,
          source_branch: body.source_branch,
          target_branch: body.target_branch,
          draft: /^draft:/i.test(String(body.title)),
        });
      }
      if (path === `${project}/merge_requests` && req.method === "GET") {
        return json(200, [mr]);
      }
      if (path === `${project}/merge_requests/11` && req.method === "GET")
        return json(200, mr);
      if (path === `${project}/merge_requests/11` && req.method === "PUT") {
        const body = await readBody();
        if (body.state_event === "close") state.closes += 1;
        if (body.state_event === "reopen") state.reopens += 1;
        return json(200, {
          ...mr,
          state: body.state_event === "close" ? "closed" : "opened",
        });
      }
      if (
        path === `${project}/merge_requests/11/notes` &&
        req.method === "POST"
      ) {
        state.comments += 1;
        return json(201, {
          id: 500 + state.comments,
          web_url: `${mr.web_url}#note_${500 + state.comments}`,
          created_at: "2026-10-29T03:10:00Z",
        });
      }
      if (
        path === `${project}/merge_requests/11/discussions` &&
        req.method === "POST"
      ) {
        const body = await readBody();
        state.inline += 1;
        state.lastInline = body;
        return json(201, {
          id: "disc-1",
          notes: [
            {
              id: 600,
              web_url: `${mr.web_url}#note_600`,
              created_at: "2026-10-29T03:11:00Z",
            },
          ],
        });
      }
      if (
        path === `${project}/merge_requests/11/merge` &&
        req.method === "PUT"
      ) {
        state.merges += 1;
        return json(200, {
          ...mr,
          state: "merged",
          merge_commit_sha: "gl-merge-sha",
        });
      }
      if (path === `${project}/pipelines` && req.method === "GET") {
        if (url.searchParams.get("page") === "2") {
          return json(200, [{ id: 76, status: "success", ref: "verify-branch", sha: "abcdef0123456789abcdef0123456789abcdef01", source: "push", web_url: "https://gitlab.example/acme/demo/-/pipelines/76", created_at: "2026-10-29T03:10:00Z", updated_at: "2026-10-29T03:12:00Z" }]);
        }
        res.setHeader("X-Next-Page", "2");
        return json(200, [{ id: 77, status: "failed", ref: "verify-branch", sha: "0123456789abcdef0123456789abcdef01234567", source: "push", web_url: "https://gitlab.example/acme/demo/-/pipelines/77", created_at: "2026-10-29T03:20:00Z", updated_at: "2026-10-29T03:24:00Z" }]);
      }
      if (path === `${project}/pipelines/77` && req.method === "GET") {
        return json(200, {
          id: 77,
          status: "failed",
          ref: "verify-branch",
          sha: "0123456789abcdef0123456789abcdef01234567",
          source: "push",
          web_url: "https://gitlab.example/acme/demo/-/pipelines/77",
          created_at: "2026-10-29T03:20:00Z",
          updated_at: "2026-10-29T03:24:00Z",
        });
      }
      if (path === `${project}/pipelines/77/jobs` && req.method === "GET") {
        return json(200, [
          {
            id: 7,
            name: "test",
            status: "failed",
            web_url: "https://gitlab.example/jobs/7",
            started_at: "2026-10-29T03:21:00Z",
            finished_at: "2026-10-29T03:24:00Z",
          },
          {
            id: 8,
            name: "build",
            status: "success",
            web_url: "https://gitlab.example/jobs/8",
            started_at: "2026-10-29T03:20:00Z",
            finished_at: "2026-10-29T03:21:00Z",
          },
        ]);
      }
      if (path === `${project}/jobs/7/trace` && req.method === "GET") {
        return text(
          200,
          "build ok\ntest line 1\nFAIL src/demo.test.ts:42: expected 1 to be 2\n",
        );
      }
      if (path === `${project}/jobs/8/trace` && req.method === "GET") {
        return text(200, "build step 1\nbuild ok\n");
      }
      if (path === `${project}/pipeline` && req.method === "POST") {
        state.triggers += 1;
        return json(201, { id: 78, status: "created", ref: "main" });
      }
      if (path === `${project}/pipelines/77/cancel` && req.method === "POST") {
        state.ciCancels += 1;
        return json(200, { id: 77, status: "canceled" });
      }
      if (path === `${project}/pipelines/77/retry` && req.method === "POST") {
        state.ciRetries += 1;
        return json(200, { id: 78, status: "pending" });
      }
      return json(404, {
        message: `gitlab mock: no route for ${req.method} ${path}`,
      });
    };
    void handle().catch((error: unknown) =>
      json(500, {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  });
  const apiUrl = `${await listen(server)}/api/v4`;
  return {
    apiUrl,
    requests,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
export type BitbucketMock = {
  apiUrl: string;
  requests: Seen[];
  state: {
    comments: number;
    merges: number;
    triggers: number;
    declines: number;
    ciStops: number;
    lastInline: any;
    fault: MockFault | null;
  };
  close: () => Promise<void>;
};
export async function startBitbucketMock(): Promise<BitbucketMock> {
  const requests: Seen[] = [];
  const state = {
    comments: 0,
    merges: 0,
    triggers: 0,
    declines: 0,
    ciStops: 0,
    lastInline: null as any,
    fault: null as MockFault | null,
  };
  const repo = "/2.0/repositories/acme/demo";
  const pull = {
    id: 21,
    state: "OPEN",
    title: "Add Bitbucket dialect",
    source: { branch: { name: "verify-branch" } },
    destination: { branch: { name: "main" } },
    author: { display_name: "Verifier" },
    links: {
      html: { href: "https://bitbucket.org/acme/demo/pull-requests/21" },
    },
    created_on: "2026-10-29T04:00:00Z",
    updated_on: "2026-10-29T04:01:00Z",
  };
  const pipeline = {
    uuid: "{pipeline-1}",
    build_number: 3,
    state: { name: "FAILED" },
    target: {
      type: "pipeline",
      ref_name: "verify-branch",
      commit: { hash: "0123456789abcdef0123456789abcdef01234567" },
    },
    links: { html: { href: "https://bitbucket.org/acme/demo/pipelines/3" } },
    created_on: "2026-10-29T04:20:00Z",
    completed_on: "2026-10-29T04:24:00Z",
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
    requests.push({
      method: req.method ?? "",
      path,
      auth: (req.headers.authorization as string | undefined) ?? null,
      privateToken:
        (req.headers["private-token"] as string | undefined) ?? null,
    });
    const { json, text, readBody, empty } = helpers(req, res);
    const handle = async () => {
      if (
        state.fault &&
        state.fault.remaining > 0 &&
        path.includes("/pipelines") &&
        (!state.fault.method || state.fault.method === req.method)
      ) {
        state.fault.remaining -= 1;
        for (const [name, value] of Object.entries(state.fault.headers ?? {})) res.setHeader(name, value);
        return json(state.fault.status, state.fault.body ?? { message: `injected ${state.fault.status}` });
      }
      if (path === repo && req.method === "GET")
        return json(200, { mainbranch: { name: "main" } });
      if (path === `${repo}/pullrequests` && req.method === "POST") {
        const body = await readBody();
        return json(201, {
          ...pull,
          id: 21,
          title: body.title,
          draft: body.draft === true,
          source: { branch: { name: body.source?.branch?.name } },
          destination: { branch: { name: body.destination?.branch?.name } },
        });
      }
      if (path === `${repo}/pullrequests` && req.method === "GET") {
        return json(200, { values: [pull] });
      }
      if (path === `${repo}/pullrequests/21` && req.method === "GET")
        return json(200, pull);
      if (
        path === `${repo}/pullrequests/21/comments` &&
        req.method === "POST"
      ) {
        const body = await readBody();
        state.comments += 1;
        state.lastInline = body.inline ?? null;
        return json(201, {
          id: 700 + state.comments,
          links: {
            html: {
              href: `https://bitbucket.org/acme/demo/pull-requests/21#comment-${700 + state.comments}`,
            },
          },
          created_on: "2026-10-29T04:10:00Z",
        });
      }
      if (path === `${repo}/pullrequests/21/merge` && req.method === "POST") {
        state.merges += 1;
        return json(200, {
          ...pull,
          state: "MERGED",
          merge_commit: { hash: "bb-merge-sha" },
        });
      }
      if (path === `${repo}/pullrequests/21/decline` && req.method === "POST") {
        state.declines += 1;
        return json(200, { ...pull, state: "DECLINED" });
      }
      if (path === `${repo}/pipelines` && req.method === "GET") {
        return json(200, { values: [pipeline] });
      }
      if (path === `${repo}/pipelines/{pipeline-1}` && req.method === "GET")
        return json(200, pipeline);
      if (
        path === `${repo}/pipelines/{pipeline-1}/steps` &&
        req.method === "GET"
      ) {
        return json(200, {
          values: [
            { uuid: "{step-0001}", name: "test", state: { name: "FAILED" } },
          ],
        });
      }
      if (
        path === `${repo}/pipelines/{pipeline-1}/steps/{step-0001}/log` &&
        req.method === "GET"
      ) {
        return text(
          200,
          "step line 1\nFAIL demo.test.ts:42: expected 1 to be 2\n",
        );
      }
      // E.3: real Bitbucket state shape (COMPLETED + result) and a paginated step list.
      if (path === `${repo}/pipelines/{pipeline-paged}` && req.method === "GET") {
        return json(200, {
          ...pipeline,
          uuid: "{pipeline-paged}",
          state: { name: "COMPLETED", type: "pipeline_state_completed", result: { name: "FAILED", type: "pipeline_state_completed_failed" } },
        });
      }
      if (path === `${repo}/pipelines/{pipeline-paged}/steps` && req.method === "GET") {
        const stepState = (result: string) => ({
          name: "COMPLETED",
          type: "pipeline_step_state_completed",
          result: { name: result, type: `pipeline_step_state_completed_${result.toLowerCase()}` },
        });
        const steps = [
          { uuid: "{step-green-01}", name: "build", started_on: "2026-10-29T04:20:05Z", state: stepState("SUCCESSFUL") },
          { uuid: "{step-green-02}", name: "lint", started_on: "2026-10-29T04:21:05Z", state: stepState("SUCCESSFUL") },
          { uuid: "{step-red-0003}", name: "test", started_on: "2026-10-29T04:22:05Z", state: stepState("FAILED") },
        ];
        const pageNo = Number(url.searchParams.get("page") ?? 1);
        const next = `http://${req.headers.host}/2.0/repositories/acme/demo/pipelines/%7Bpipeline-paged%7D/steps/?page=2&pagelen=100`;
        // Two steps on page 1, the failing one on page 2 (the next page URL lives in the body).
        return pageNo === 1
          ? json(200, { values: steps.slice(0, 2), size: 3, page: 1, pagelen: 2, next })
          : json(200, { values: steps.slice(2), size: 3, page: 2, pagelen: 2 });
      }
      if (path === `${repo}/pipelines/{pipeline-paged}/steps/{step-red-0003}/log` && req.method === "GET") {
        return text(200, "test line 1\nRED-FAIL-LINE demo.test.ts:7\n");
      }
      if (path === `${repo}/pipelines/{pipeline-paged}/steps/{step-green-01}/log` && req.method === "GET") {
        return text(200, "green-log build ok\n");
      }
      if (path === `${repo}/pipelines` && req.method === "POST") {
        state.triggers += 1;
        return json(201, { uuid: "{pipeline-2}", state: { name: "PENDING" } });
      }
      if (path === `${repo}/pipelines/{pipeline-1}/stopPipeline` && req.method === "POST") {
        state.ciStops += 1;
        return empty(204);
      }
      return json(404, {
        message: `bitbucket mock: no route for ${req.method} ${path}`,
      });
    };
    void handle().catch((error: unknown) =>
      json(500, {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  });
  const apiUrl = `${await listen(server)}/2.0`;
  return {
    apiUrl,
    requests,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
