// The root clones' pre-push hook (see hooks/pre-push). git gives it the remote's name and
// URL as arguments and one line per ref on stdin: <local ref> <local sha> <remote ref> <remote sha>.
//
// Pushes through desolate's own helpers (to a domain; to `origin`, whose push address is
// git-remote-desolate-push) are gated there. What is left for this hook is a push straight
// to the remote's address, by hand. That cannot reach the remote: this user has no way to a
// write key (only the pusher does, root/pusher.ts). The hook refuses it first, and says why.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { parseRepo } from "../shared/names.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

/** A push through desolate's own helpers (to a domain, or to `origin` as a root clone's push
 *  address names it) is gated there: this hook lets it be. */
export const throughHelper = (url: string | undefined) =>
  (url ?? "").startsWith("desolate::") || (url ?? "").startsWith("desolate-push::");

/** Anything else is a push straight to the remote's address, which this user cannot make: what
 *  it is told. (`repoName`: the clone's desolate.repo.) */
export const refusal = (repoName: string): { message: string; fix: string } =>
  !parseRepo(repoName)
    ? {
        message: "this is not one of the root's clones",
        fix: "push from a clone under /desolate/root",
      }
    : // No push from here reaches the remote's address with a key: this user has none. Said
      // plainly, before git tries.
      {
        message: `a push straight to the remote's address is not something ${repoName}'s root clone can make: the write key is the pusher's alone`,
        fix: "git push origin <branch> (it asks, and you approve on the host), or `desolate push` on the host",
      };

declare namespace throughHelper {
  /** a domain, or origin's push address in a root clone: desolate's helpers, which gate it */
  export type Helpers = Table<
    typeof throughHelper,
    [
      [args: [url: "desolate::acme"], expected: true],
      [args: [url: "desolate-push::acme/app"], expected: true],
    ]
  >;
  /** the remote's own address, or one only named like it, is not */
  export type Straight = Table<
    typeof throughHelper,
    [
      [args: [url: "ssh://git@github.com:22/acme/app.git"], expected: false],
      [args: [url: "git@github.com:acme/desolate::x.git"], expected: false],
      [args: [url: undefined], expected: false],
    ]
  >;
}

declare namespace refusal {
  /** refused, and told how a push from here is made */
  export type Says = Table<
    typeof refusal,
    [
      [
        args: [repoName: "acme/app"],
        expected: {
          message: "a push straight to the remote's address is not something acme/app's root clone can make: the write key is the pusher's alone";
          fix: "git push origin <branch> (it asks, and you approve on the host), or `desolate push` on the host";
        },
      ],
      [
        args: [repoName: ""],
        expected: {
          message: "this is not one of the root's clones";
          fix: "push from a clone under /desolate/root";
        },
      ],
    ]
  >;
}

const main = () => {
  const [, , , url] = process.argv;
  if (throughHelper(url)) process.exit(0);
  const repoName = spawnSync("git", ["config", "--get", "desolate.repo"], {
    encoding: "utf8",
  }).stdout.trim();
  const { message, fix } = refusal(repoName);
  process.stderr.write(`desolate: ${message}\n  fix: ${fix}\n`);
  process.exit(1);
};

// Run by git, as a root clone's pre-push hook (hooks/pre-push, a wrapper that runs node with
// this file's path); imported, it does nothing.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname)
  main();
