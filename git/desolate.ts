// `desolate` in the git VM: what the person may ask of the root from here, besides a push
// (which is `git push`: git-remote-desolate-out.ts).
//
//   desolate fetch [<owner/repo>]   the root refreshes the mirror from the remote (with its
//                                   read key; this VM has none), then this fetches every
//                                   remote of the clone: origin, root, and each domain's.
//                                   Unnamed: the clone you are in and the others of its
//                                   domains; outside a clone, every clone here
//   desolate upstream [<consumer>] <dependency-dir> <owner/repo> [--from <ref>]
//                                   suede's upstream, desolate's pinned copy: a consumer's
//                                   change to a vendored dependency, proposed to the
//                                   dependency as a push you approve (upstream.ts)
//
// The request goes the way a push does (shared/git-out-box.ts): a file in /desolate/out, the host's
// answer in /desolate/answers. It names a repository and nothing else, and is waited for as
// long as you wait: Ctrl-C withdraws it.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { newId, requester } from "../shared/git-out-box.ts";
import { parseRepo } from "../shared/names.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

const fail = (message: string, fix?: string): never => {
  process.stderr.write(`desolate: ${message}\n${fix ? `  fix: ${fix}\n` : ""}`);
  process.exit(1);
};

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
    // (It becomes a path here, /git/<owner>/<repo>: names.ts's rule leaves none that climbs.)
    return parseRepo(named)
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

/** The clones `desolate fetch` fetches when none is named: the one you are in (`here`) and
 *  every other clone of a domain it is in (a domain is a remote of each of its clones,
 *  host/git-vm.ts ensureGitClone); outside a clone, every one. `remotes`: each clone's. */
export const toFetch = (here: string | null, remotes: Record<string, string[]>): string[] => {
  const all = Object.keys(remotes);
  if (here === null) return all;
  const domains = (remotes[here] ?? []).filter((r) => r !== "origin" && r !== "root");
  return [here, ...all.filter((c) => c !== here && remotes[c]!.some((r) => domains.includes(r)))];
};

declare namespace toFetch {
  export type Cases = Table<
    typeof toFetch,
    [
      [
        args: [
          here: "acme/web",
          remotes: {
            "acme/api": ["origin", "root", "standup"];
            "acme/web": ["origin", "root", "standup"];
            "acme/other": ["origin", "root", "pantry"];
          },
        ],
        expected: ["acme/web", "acme/api"],
      ],
      /** origin and root are every clone's: they make no two clones kin */
      [
        args: [
          here: "acme/web",
          remotes: { "acme/web": ["origin", "root"]; "acme/api": ["origin", "root"] },
        ],
        expected: ["acme/web"],
      ],
      [
        args: [here: null, remotes: { "acme/web": ["origin"]; "acme/api": ["origin"] }],
        expected: ["acme/web", "acme/api"],
      ],
    ]
  >;
}

/** The clone the current directory is in, if it is one. */
const here = () =>
  cloneOf(spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim());

/** Each clone here (/git/<owner>/<repo>), with its remotes. */
const remotesHere = (): Record<string, string[]> => {
  const found: Record<string, string[]> = {};
  for (const owner of fs.readdirSync("/git", { withFileTypes: true })) {
    if (!owner.isDirectory()) continue;
    for (const name of fs.readdirSync(`/git/${owner.name}`, { withFileTypes: true })) {
      const repo = `${owner.name}/${name.name}`;
      if (!name.isDirectory() || !parseRepo(repo) || !fs.existsSync(`/git/${repo}/.git`)) continue;
      const listed = spawnSync("git", ["-C", `/git/${repo}`, "remote"], { encoding: "utf8" });
      found[repo] = listed.stdout.split("\n").filter(Boolean);
    }
  }
  return found;
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
    const all = args[0] ? {} : remotesHere();
    const clones = args[0] ? [repoOf(args[0])] : toFetch(here(), all);
    let failed = 0;
    for (const repo of clones) {
      const dir = `/git/${repo}`;
      if (!fs.existsSync(path.join(dir, ".git"))) {
        process.stderr.write(
          `desolate: no clone of ${repo} here\n  fix: on the Mac: desolate git ${repo}\n`,
        );
        failed++;
        continue;
      }
      const reply = await requester().ask(newId(), { op: "fetch", repo }, (line) =>
        process.stderr.write(`${line}\n`),
      );
      for (const line of Array.isArray(reply.said) ? reply.said : [])
        process.stderr.write(`${String(line)}\n`);
      if (reply.fetched !== true) {
        process.stderr.write(
          `desolate: the root could not refresh ${repo}: ${String(reply.error ?? "no reason given")}\n  fix: on the Mac: desolate fetch ${repo}\n`,
        );
        failed++;
        continue;
      }
      const fetched = spawnSync("git", ["-C", dir, "fetch", "--all", "--prune"], {
        stdio: "inherit",
      });
      if (fetched.status !== 0) failed++;
    }
    // Which were fetched, said plainly: the one you are in was, alone, and another clone of
    // the same domain showed a main two merges old (dogfooding, 2026-11-22).
    process.stderr.write(
      `desolate: fetched ${clones.length - failed} of ${clones.length}: ${clones.join(", ")}${clones.length < Object.keys(all).length ? " (the clones of its domains; in /git, desolate fetch fetches every clone)" : ""}\n`,
    );
    process.exit(failed ? 1 : 0);
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
        "  desolate fetch [<owner/repo>]   refresh the mirror from the remote, then git fetch --all:",
        "                                  the clone named, or the one you are in and the other",
        "                                  clones of its domains, or (in /git) every clone",
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
