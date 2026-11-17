// `desolate` in the git VM: what the person may ask of the root from here, besides a push
// (which is `git push`: git-remote-desolate-out.ts).
//
//   desolate fetch [<owner/repo>]   the root refreshes the mirror from the remote (with its
//                                   read key; this VM has none), then this fetches every
//                                   remote here: origin, root, and each domain's
//   desolate upstream [<consumer>] <dependency-dir> <owner/repo> [--from <ref>]
//                                   suede's upstream, desolate's pinned copy: a consumer's
//                                   change to a vendored dependency, proposed to the
//                                   dependency as a push you approve (upstream.ts)
//
// The request goes the way a push does: a file in /desolate/out, the host's answer in
// /desolate/answers. It names a repository and nothing else.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

const OUT = "/desolate/out";
const ANSWERS = "/desolate/answers";
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const fail = (message: string, fix?: string): never => {
  process.stderr.write(`desolate: ${message}\n${fix ? `  fix: ${fix}\n` : ""}`);
  process.exit(1);
};

/** A repository as the person names it: the request carries it to the host, and it becomes
 *  a path (/git/<owner>/<repo>) here. */
export const isRepo = (named: string) => REPO.test(named);

declare namespace isRepo {
  export type Names = Table<
    typeof isRepo,
    [
      [args: [named: "acme/app"], expected: true],
      [args: [named: "pmalacho-mit/suede.nests"], expected: true],
      [args: [named: "acme"], expected: false],
      [args: [named: "acme/app/x"], expected: false],
      [args: [named: "acme/app;id"], expected: false],
      [args: [named: "acme/app name"], expected: false],
      [args: [named: "acme/app\n"], expected: false],
    ]
  >;
  /** dots are allowed in a part, so `..` is too, which as a path would leave /git. The host
   *  reads the request's name with parseRepo (host/git-vm.ts), which refuses it */
  export type Dots = Table<
    typeof isRepo,
    [[args: [named: "../app"], expected: true], [args: [named: "acme/.."], expected: true]]
  >;
}

/** The clone a working tree's top is: /git/<owner>/<repo>. */
export const cloneOf = (toplevel: string): string | null =>
  /^\/git\/([^/]+\/[^/]+)$/.exec(toplevel)?.[1] ?? null;

declare namespace cloneOf {
  export type Clone = Expect<Invoke<typeof cloneOf, [toplevel: "/git/acme/app"]>, "=", "acme/app">;
  export type Elsewhere = Table<
    typeof cloneOf,
    [
      [args: [toplevel: "/git/acme/app/vendor/lib"], expected: null],
      [args: [toplevel: "/home/me/app"], expected: null],
      [args: [toplevel: ""], expected: null],
    ]
  >;
}

/** The clone the current directory is in (/git/<owner>/<repo>), or the one named. */
const repoOf = (named: string | undefined): string => {
  if (named)
    return isRepo(named)
      ? named
      : fail(`'${named}' is not a repository`, "name it as <owner>/<repo>");
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).stdout.trim();
  return (
    cloneOf(top) ??
    fail(
      "this directory is not one of your clones",
      "cd /git/<owner>/<repo>, or name it: desolate fetch <owner>/<repo>",
    )
  );
};

const ask = async (
  request: Record<string, unknown>,
  waitMs: number,
): Promise<Record<string, unknown>> => {
  const id = randomBytes(8).toString("hex");
  const file = path.join(OUT, `${id}.json`);
  fs.writeFileSync(`${file}.part`, JSON.stringify(request));
  fs.renameSync(`${file}.part`, file);
  const answer = path.join(ANSWERS, `${id}.json`);
  for (
    const until = Date.now() + waitMs;
    Date.now() < until;
    await new Promise((resolve) => setTimeout(resolve, 250))
  )
    if (fs.existsSync(answer))
      return JSON.parse(fs.readFileSync(answer, "utf8")) as Record<string, unknown>;
  return fail(
    `the host did not answer in ${waitMs / 60_000} minutes`,
    "on the Mac: desolate doctor",
  );
};

/** The exit code of `desolate` with no verb it knows: 0 when the usage was asked for. */
export const usageExit = (verb: string | undefined) => (verb && verb !== "help" ? 64 : 0);

declare namespace usageExit {
  export type Cases = Table<
    typeof usageExit,
    [
      [args: [verb: undefined], expected: 0],
      [args: [verb: "help"], expected: 0],
      [args: [verb: "offer"], expected: 64],
    ]
  >;
}

const main = async (argv: string[]) => {
  const [verb, ...args] = argv;
  if (verb === "fetch") {
    const repo = repoOf(args[0]);
    const dir = `/git/${repo}`;
    if (!fs.existsSync(path.join(dir, ".git")))
      fail(`no clone of ${repo} here`, `on the Mac: desolate git ${repo}`);
    process.stderr.write(`desolate: asking the root to refresh ${repo} from its remote...\n`);
    const reply = await ask({ op: "fetch", repo }, 10 * 60_000);
    for (const line of Array.isArray(reply.said) ? reply.said : [])
      process.stderr.write(`${String(line)}\n`);
    if (reply.fetched !== true)
      fail(
        `the root could not refresh ${repo}: ${String(reply.error ?? "no reason given")}`,
        `on the Mac: desolate fetch ${repo}`,
      );
    const fetched = spawnSync("git", ["-C", dir, "fetch", "--all", "--prune"], {
      stdio: "inherit",
    });
    process.exit(fetched.status ?? 1);
  } else if (verb === "upstream") {
    const { upstream, Stop } = await import("./upstream.ts");
    try {
      process.exit(await upstream(args, () => repoOf(undefined)));
    } catch (error) {
      if (error instanceof Stop) fail(error.message, error.fix);
      throw error;
    }
  } else {
    process.stdout.write(
      [
        "desolate, in the git VM:",
        "  desolate fetch [<owner/repo>]   refresh the mirror from the remote, then git fetch --all",
        "  git push origin <branch>        push it: you approve it on the approval page",
        "  git push <domain> <branch>      deliver it to a domain: its workspaces see root/<branch>",
        "  git fetch <domain>              what a domain's workspaces wrote: <domain>/<branch>",
        "  desolate upstream <dependency-dir> <owner/repo> [--from <domain>/<branch>]",
        "                                  propose a vendored suede dependency's change to it",
        "                                  (suede's upstream, pinned; you approve the push)",
        "",
      ].join("\n"),
    );
    process.exit(usageExit(verb));
  }
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
