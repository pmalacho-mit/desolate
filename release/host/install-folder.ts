// The folder desolate is installed in (RELEASE_DIR) is shared read-only into every VM, its git
// directory too when it is a clone (getting-started.md: `git clone --branch release ...`). A
// credential in that clone's git settings would be readable in every workspace, so a VM is not
// started while there is one.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { RELEASE_DIR } from "./paths.ts";
import type { Expect, Invoke } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { sharedFolderWith } from "../.harness/host-install-folder.ts";

/** The git config files of `dir`'s clone: `.git/config`, or, when `.git` is a file naming a
 *  git directory (a worktree, a submodule), that directory's config and its common one's. */
const configFiles = (dir: string): string[] => {
  const dotGit = path.join(dir, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return [];
  }
  if (stat.isDirectory()) return [path.join(dotGit, "config")];
  const named = /^gitdir: (.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
  if (!named) return [];
  const gitDir = path.resolve(dir, named);
  const files = [path.join(gitDir, "config")];
  try {
    const common = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    files.push(path.join(path.resolve(gitDir, common), "config"));
  } catch {}
  return files;
};

/** "<scheme>://<user>[:<password>]@": a user and maybe a password in an address. A bare
 *  `git@` (an ssh address) names no one's credential. */
const userinfo = (text: string) =>
  [...text.matchAll(/:\/\/([^/@\s]+)@/g)].some((match) => match[1] !== "git");

/** Why a setting holds a credential, or null. Its value is never part of the answer. */
const holdsCredential = (key: string, value: string): boolean => {
  if (/^remote\..*\.(url|pushurl)$/.test(key)) return userinfo(value);
  // url.<base>.insteadOf: the address with a credential may be the base, in the key itself.
  if (/^url\..*\.(insteadof|pushinsteadof)$/.test(key)) return userinfo(key) || userinfo(value);
  // A header sent with every request: what an Actions checkout leaves (an Authorization).
  if (/^http\.(.*\.)?extraheader$/.test(key)) return true;
  // Of credential.*, only what holds a credential inline: a username or password set there,
  // or a helper that is a shell command ("!..."), which may print one. A helper's name
  // ("osxkeychain") holds nothing.
  if (/^credential\.(.*\.)?(username|password)$/.test(key)) return true;
  if (/^credential\.(.*\.)?helper$/.test(key)) return value.trim().startsWith("!");
  return false;
};

/** A key as it may be said: an address in it with its user and password replaced. */
const sayable = (key: string) => key.replace(/:\/\/[^/@\s]+@/g, "://***@");

/** Why no VM may start with `dir` shared into it, and what to do, or null when nothing in
 *  its clone's git settings holds a credential. */
export const sharedFolderRefusal = (dir = RELEASE_DIR): { why: string; fix: string } | null => {
  const shared = `${dir} is shared read-only into every VM`;
  for (const file of configFiles(dir)) {
    if (!fs.existsSync(file)) continue;
    const listed = spawnSync("git", ["config", "--file", file, "--list", "-z"], {
      encoding: "utf8",
    });
    // Not read is not clean: the settings may hold anything.
    if (listed.status !== 0)
      return {
        why: `${file} could not be read (${(listed.stderr || String(listed.error ?? "")).trim().split("\n")[0]}), and ${shared}, so a credential in it would be readable in every workspace`,
        fix: `git config --file ${file} --list`,
      };
    for (const entry of listed.stdout.split("\0")) {
      if (!entry) continue;
      const at = entry.indexOf("\n");
      const key = at < 0 ? entry : entry.slice(0, at);
      const value = at < 0 ? "" : entry.slice(at + 1);
      if (!holdsCredential(key, value)) continue;
      const fix =
        key === "remote.origin.url"
          ? `git -C ${dir} remote set-url origin https://github.com/pmalacho-mit/desolate`
          : sayable(key) === key
            ? `git -C ${dir} config --unset ${key}`
            : `git -C ${dir} config --edit (and remove the ${sayable(key)} setting)`;
      return {
        why: `${file} sets ${sayable(key)}, which holds a credential, and ${shared}: every workspace could read it`,
        fix,
      };
    }
  }
  return null;
};

declare namespace sharedFolderRefusal {
  /** a token in the remote's address is refused, and the refusal does not say the token */
  export type Token = Expect<
    Invoke<
      typeof sharedFolderWith,
      [
        check: typeof sharedFolderRefusal,
        files: {
          ".git/config": '[remote "origin"]\n\turl = https://someone:ghp_secret123@github.com/pmalacho-mit/desolate\n';
        },
      ]
    >,
    "=",
    {
      why: "<dir>/.git/config sets remote.origin.url, which holds a credential, and <dir> is shared read-only into every VM: every workspace could read it";
      fix: "git -C <dir> remote set-url origin https://github.com/pmalacho-mit/desolate";
    }
  >;
  /** a header sent with every request (an Actions checkout's), whatever it holds */
  export type ExtraHeader = Expect<
    Invoke<
      typeof sharedFolderWith,
      [
        check: typeof sharedFolderRefusal,
        files: {
          ".git/config": '[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic eHh4\n';
        },
      ]
    >,
    "=",
    {
      why: "<dir>/.git/config sets http.https://github.com/.extraheader, which holds a credential, and <dir> is shared read-only into every VM: every workspace could read it";
      fix: "git -C <dir> config --unset http.https://github.com/.extraheader";
    }
  >;
  /** an address with a credential in a url.<base>.insteadOf's base is not said either */
  export type InsteadOf = Expect<
    Invoke<
      typeof sharedFolderWith,
      [
        check: typeof sharedFolderRefusal,
        files: {
          ".git/config": '[url "https://x-access-token:ghs_secret@github.com/"]\n\tinsteadOf = https://github.com/\n';
        },
      ]
    >,
    "=",
    {
      why: "<dir>/.git/config sets url.https://***@github.com/.insteadof, which holds a credential, and <dir> is shared read-only into every VM: every workspace could read it";
      fix: "git -C <dir> config --edit (and remove the url.https://***@github.com/.insteadof setting)";
    }
  >;
  /** a worktree's .git is a file: the settings of the git directory it names are read */
  export type GitFile = Expect<
    Invoke<
      typeof sharedFolderWith,
      [
        check: typeof sharedFolderRefusal,
        files: {
          ".git": "gitdir: elsewhere/worktrees/w\n";
          "elsewhere/worktrees/w/commondir": "../..\n";
          "elsewhere/config": '[remote "origin"]\n\turl = https://someone:ghp_secret123@github.com/o/r\n';
        },
      ]
    >,
    "matches",
    {
      why: "<dir>/elsewhere/config sets remote.origin.url, which holds a credential, and <dir> is shared read-only into every VM: every workspace could read it";
    }
  >;
  /** controls: a plain https address, an ssh one with its git@, a helper's name, no clone */
  export type Clean = [
    Expect<
      Invoke<
        typeof sharedFolderWith,
        [
          check: typeof sharedFolderRefusal,
          files: {
            ".git/config": '[remote "origin"]\n\turl = https://github.com/pmalacho-mit/desolate\n[credential]\n\thelper = osxkeychain\n';
          },
        ]
      >,
      "=",
      null
    >,
    Expect<
      Invoke<
        typeof sharedFolderWith,
        [
          check: typeof sharedFolderRefusal,
          files: {
            ".git/config": '[remote "origin"]\n\turl = git@github.com:o/r.git\n\tpushurl = ssh://git@github.com/o/r.git\n';
          },
        ]
      >,
      "=",
      null
    >,
    Expect<
      Invoke<
        typeof sharedFolderWith,
        [check: typeof sharedFolderRefusal, files: { "README.md": "desolate\n" }]
      >,
      "=",
      null
    >,
  ];
}
