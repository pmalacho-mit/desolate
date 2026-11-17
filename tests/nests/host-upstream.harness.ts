// Harness for the in-source tests of release/host/upstream.ts: a stand-in for GitHub's API (no
// network: `fetch` is replaced for the test, and the API's address is one nothing answers at),
// and what the command said. Imported by the tests as types only, so nothing here reaches the
// release (release/nests-harness.d.ts).
import { onTestFinished, vi } from "vitest";
import type { Repo } from "../../release/shared/names.ts";
import type { upstreamCommand, waitForPull } from "../../release/host/upstream.ts";

const API = "http://forge.test";
const ENV = ["SUEDE_GITHUB_API", "SUEDE_UPSTREAM_WAIT", "SUEDE_UPSTREAM_INTERVAL", "GH_TOKEN", "GITHUB_TOKEN"] as const;

/** Runs waitForPull against an API that answers each route starting with a key of `routes`
 *  with its JSON, and every other with 404. Waits up to `waitS` seconds, asking every 10 ms.
 *  No token is in the environment: none is the person's to send. What it returned, the
 *  lines it said, and each route it asked with whether it sent a token. */
export const pullWaitedFor = async (wait: typeof waitForPull, dependency: Repo, branch: string, waitS: string, routes: Record<string, unknown>) => {
  const before = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  onTestFinished(() => {
    vi.unstubAllGlobals();
    for (const name of ENV) if (before[name] === undefined) delete process.env[name];
    else process.env[name] = before[name];
  });
  Object.assign(process.env, { SUEDE_GITHUB_API: API, SUEDE_UPSTREAM_WAIT: waitS, SUEDE_UPSTREAM_INTERVAL: "0.01" });
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const asked: { route: string; token: boolean }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
    const route = url.slice(API.length + 1);
    asked.push({ route, token: "authorization" in init.headers });
    const key = Object.keys(routes).find((prefix) => route.startsWith(prefix));
    return key === undefined ? new Response("{}", { status: 404 }) : Response.json(routes[key]);
  });
  const lines: string[] = [];
  const code = await wait(dependency, branch, (line) => void lines.push(line));
  return { code, lines, asked };
};

/** What `desolate upstream` said, or the refusal it ended with: its words, its fix, its exit code. */
export const upstreamSays = async (command: typeof upstreamCommand, positionals: string[], values: Record<string, unknown>) => {
  const lines: string[] = [];
  try {
    return { code: await command(positionals, values, (line) => void lines.push(line)), lines };
  } catch (error) {
    const { message, fix, code } = error as { message: string; fix?: unknown; code?: unknown };
    return { refused: message, fix: String(fix), code };
  }
};
