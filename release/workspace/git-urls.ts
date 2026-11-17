// A domain's repositories by their GitHub addresses, inside its workspaces.
//
// Tools name a repository by its address, not by a workspace's origin: suede's install and
// sync (`git@github.com:o/r.git`, recorded in a .gitrepo), a git dependency in package.json,
// `git clone https://github.com/o/r.git`. A workspace has no credentials, so a private one
// could not be read at all, and a public one was read past the mirror the domain already has.
//
// These rules send each address of a repository the domain holds to the helpers origin uses
// (init.ts): a fetch goes to the domain's read-only mirror, refreshed first
// (git-remote-desolate-mirror), and a push becomes an offer (git-remote-desolate-offer).
// Nothing reaches anything the domain could not already read. Set in git's global config
// (the VM's user, and the devcontainer's: devcontainer.ts), because a tool may run git
// outside every checkout (suede's install fetches into a repository of its own in /tmp).
//
// Only the `.git` spellings: insteadOf rewrites a prefix, and `https://github.com/o/app`
// would also rewrite `https://github.com/o/app-other.git` into a repository that is not it.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

/** `git config --global` argument lists, in order: each rule's old values, then the new ones. */
export const urlRules = (repos: readonly string[]): string[][] =>
  repos.flatMap((repo) =>
    (
      [
        ["insteadOf", "desolate-mirror"],
        ["pushInsteadOf", "desolate-offer"],
      ] as const
    ).flatMap(([kind, helper]) => {
      const key = `url.${helper}::${repo}.${kind}`;
      return [
        ["--unset-all", key],
        ...[
          `git@github.com:${repo}.git`,
          `ssh://git@github.com/${repo}.git`,
          `https://github.com/${repo}.git`,
        ].map((address) => ["--add", key, address]),
      ];
    }),
  );

declare namespace urlRules {
  /** each address of each repository, to the mirror for a fetch and to an offer for a push */
  export type OneRepository = Table<
    typeof urlRules,
    [
      [
        args: [repos: ["o/r"]],
        expected: [
          ["--unset-all", "url.desolate-mirror::o/r.insteadOf"],
          ["--add", "url.desolate-mirror::o/r.insteadOf", "git@github.com:o/r.git"],
          ["--add", "url.desolate-mirror::o/r.insteadOf", "ssh://git@github.com/o/r.git"],
          ["--add", "url.desolate-mirror::o/r.insteadOf", "https://github.com/o/r.git"],
          ["--unset-all", "url.desolate-offer::o/r.pushInsteadOf"],
          ["--add", "url.desolate-offer::o/r.pushInsteadOf", "git@github.com:o/r.git"],
          ["--add", "url.desolate-offer::o/r.pushInsteadOf", "ssh://git@github.com/o/r.git"],
          ["--add", "url.desolate-offer::o/r.pushInsteadOf", "https://github.com/o/r.git"],
        ],
      ],
      [args: [repos: []], expected: []],
    ]
  >;
  /** the key names the repository, so setting one repository's rules again (`--unset-all`
   *  first) leaves every other's alone */
  export type EachItsOwn = [
    Expect<Invoke<typeof urlRules, [repos: ["acme/app", "acme/lib"]]>["length"], "=", 16>,
    Expect<
      Invoke<typeof urlRules, [repos: ["acme/app", "acme/lib"]]>[8],
      "=",
      ["--unset-all", "url.desolate-mirror::acme/lib.insteadOf"]
    >,
  ];
  /** a name with dots is still one key: git takes the section and the variable at the first
   *  and the last dot, and everything between is the subsection */
  export type DotsInTheName = Expect<
    Invoke<typeof urlRules, [repos: ["acme/suede.nests"]]>[3],
    "=",
    [
      "--add",
      "url.desolate-mirror::acme/suede.nests.insteadOf",
      "https://github.com/acme/suede.nests.git",
    ]
  >;
}
