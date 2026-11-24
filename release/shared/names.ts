// Names: one spelling each. A slug becomes a VM name, a hostname and a path, so it is
// validated once, here, and nothing downstream re-interprets it (move-to-vms.md section 2;
// v2's `owner/repo` as `owner__repo` needed a whole rule set, so v3 never encodes one).
import { createHash } from "node:crypto";
import { NAMES, over, PORTS } from "./limits.ts";
import { define, valueOf, whole } from "./settings.ts";
import { printable } from "./text.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type {
  Expect,
  Given,
  Invoke,
  Table,
  Throws,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { setEnv } from "../.harness/env.ts";
import type { branchOf } from "../.harness/shared-names.ts";

/** A domain's or a workspace's name: limits.ts's NAMES.slug says how long and why. */
export const SLUG = new RegExp(`^[a-z0-9][a-z0-9-]{0,${NAMES.slug - 1}}$`);
/** GitHub's own rules, narrowed: no leading dot or dash, no "..", no ".git" suffix. */
const REPO_PART = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** At most one `--`: it is the separator in a domain named `owner--repo`, which clone makes,
 *  and a slug's single dashes collapse runs, so it is never ambiguous. Never `xn--` first: a
 *  hostname label that starts so is punycode to a browser. */
export const isSlug = (value: unknown): value is string =>
  typeof value === "string" &&
  SLUG.test(value) &&
  !value.endsWith("-") &&
  value.split("--").length <= 2 &&
  !value.startsWith("xn--") &&
  !/-{3}/.test(value);

/** How many characters (code points: R8) a text is; `length` counts UTF-16 units, and an
 *  emoji is two of those. */
export const characters = (text: string): number => {
  let n = 0;
  for (const _ of text) n++;
  return n;
};

declare namespace characters {
  /** code points, not UTF-16 units */
  export type Counts = Table<
    typeof characters,
    [
      [args: [text: "abc"], expected: 3],
      [args: [text: "Caf\u00e9"], expected: 4],
      [args: [text: "\u{1F600}x"], expected: 2],
      [args: [text: ""], expected: 0],
    ]
  >;
}

/** Why `value` is not a slug (R3: the rule, and the bound with the value when that is what
 *  it missed), or null when it is one. `what` names it: "domain", "workspace". For a caller
 *  to refuse with, in place of its own copy of the rule. */
export const slugRefusal = (value: unknown, what: string): string | null => {
  if (isSlug(value)) return null;
  const rule = `a ${what} name is a slug: lowercase letters, digits and single dashes, at most ${NAMES.slug}, starting with a letter or digit`;
  if (typeof value !== "string") return rule;
  const n = characters(value);
  return n > NAMES.slug
    ? `${over(`the ${what} name`, NAMES.slug, n, "characters")}: ${rule}`
    : rule;
};

declare namespace slugRefusal {
  /** the rule, and the bound by its number when that is what was missed */
  export type Says = Table<
    typeof slugRefusal,
    [
      [args: [value: "acme", what: "domain"], expected: null],
      [
        args: [value: "Acme", what: "domain"],
        expected: "a domain name is a slug: lowercase letters, digits and single dashes, at most 40, starting with a letter or digit",
      ],
      [
        args: [value: "abcdefghij-abcdefghij-abcdefghij-abcdefghij", what: "workspace"],
        expected: "the workspace name is 43 characters, over the 40 allowed: a workspace name is a slug: lowercase letters, digits and single dashes, at most 40, starting with a letter or digit",
      ],
    ]
  >;
}

export type Repo = { owner: string; name: string };

export const parseRepo = (value: unknown): Repo | null => {
  if (typeof value !== "string") return null;
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  for (const part of [owner, name])
    if (!REPO_PART.test(part) || part.includes("..") || part.endsWith(".git") || part.endsWith("."))
      return null;
  return { owner, name };
};

declare namespace isSlug {
  /** what a domain or workspace may be called: it becomes a VM name, a hostname and a path */
  export type Names = Table<
    typeof isSlug,
    [
      [args: [value: "acme"], expected: true],
      [args: [value: "issue-12"], expected: true],
      [args: [value: "Acme"], expected: false],
      [args: [value: "-acme"], expected: false],
      [args: [value: "acme-"], expected: false],
      [args: [value: "acme--widgets"], expected: true],
      [args: [value: "a--b--c"], expected: false],
      [args: [value: "a---b"], expected: false],
      [args: [value: "xn--widgets"], expected: false],
      [args: [value: "a.b"], expected: false],
      [args: [value: "x234567890123456789012345678901234567890"], expected: true],
      [args: [value: "x2345678901234567890123456789012345678901"], expected: false],
    ]
  >;
}

declare namespace parseRepo {
  /** owner/name, and nothing that could leave the directory it names */
  export type Accepts = Expect<
    Invoke<typeof parseRepo, [value: "acme/widgets"]>,
    "=",
    { owner: "acme"; name: "widgets" }
  >;
  export type Refuses = Table<
    typeof parseRepo,
    [
      [args: [value: "acme"], expected: null],
      [args: [value: "acme/widgets/x"], expected: null],
      [args: [value: "../widgets"], expected: null],
      [args: [value: "acme/.."], expected: null],
      [args: [value: "acme/widgets.git"], expected: null],
      [args: [value: "-acme/widgets"], expected: null],
      [args: [value: ".hidden/widgets"], expected: null],
      [args: [value: "acme/widgets."], expected: null],
      [args: [value: "acme/a..b"], expected: null],
      [args: [value: "acme/my widgets"], expected: null],
      [args: [value: 42], expected: null],
      /** GitHub allows a name that starts with a dot (an owner's `.github`), and this refuses
       *  it: every copy of this rule now refuses it too (the git VM's and the recipes' took it,
       *  though the host refused it before they were reached) */
      [args: [value: "acme/.github"], expected: null],
    ]
  >;
}

export const repoId = (repo: Repo) => `${repo.owner}/${repo.name}`;

declare namespace repoId {
  /** a repository as text, its own case kept: what parseRepo read */
  export type Spelled = Expect<
    Invoke<typeof repoId, [repo: { owner: "Acme"; name: "My_App.js" }]>,
    "=",
    "Acme/My_App.js"
  >;
}

/** The domain `clone` makes a repository: `owner--repo`, each part a slug (its runs of
 *  anything else one dash, so `--` is only ever the separator). Too long for a slug: cut, and
 *  a hash of the whole keeps it apart from another cut the same way. Never `owner/repo`
 *  itself: a domain's name is a VM label, a hostname and a path. */
export const domainNameFor = (repo: Repo): string => {
  const part = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x";
  let name = `${part(repo.owner)}--${part(repo.name)}`;
  if (name.startsWith("xn--")) name = `gh-${name}`;
  if (name.length > NAMES.slug)
    name = `${name.slice(0, NAMES.slug - 7).replace(/-+$/, "")}-${hex(repoId(repo).toLowerCase(), 6)}`;
  return name;
};

declare namespace domainNameFor {
  /** owner and name, a double dash between */
  export type Names = Table<
    typeof domainNameFor,
    [
      [args: [repo: { owner: "acme"; name: "widgets" }], expected: "acme--widgets"],
      [
        args: [repo: { owner: "pmalacho-mit"; name: "suede.nests" }],
        expected: "pmalacho-mit--suede-nests",
      ],
      [args: [repo: { owner: "Acme"; name: "My__App" }], expected: "acme--my-app"],
      [args: [repo: { owner: "acme"; name: "a--b" }], expected: "acme--a-b"],
      [args: [repo: { owner: "xn"; name: "app" }], expected: "gh-xn--app"],
      /** too long for a slug: cut, and a hash of the whole keeps two names cut alike apart */
      [
        args: [
          repo: {
            owner: "a-very-long-organisation-name";
            name: "and-an-even-longer-repository-name";
          },
        ],
        expected: "a-very-long-organisation-name--an-1ab687",
      ],
      [
        args: [
          repo: {
            owner: "a-very-long-organisation-name";
            name: "and-an-even-longer-repository-other";
          },
        ],
        expected: "a-very-long-organisation-name--an-08ee6f",
      ],
    ]
  >;
}

export const isBranch = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= NAMES.branch &&
  /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
  !value.includes("..") &&
  !value.includes("//") &&
  !value.endsWith("/") &&
  !value.endsWith(".lock") &&
  !value.endsWith(".") &&
  !value.includes("@{");

/** Why `value` is not a branch desolate carries (R3: the bound and the value, when that is
 *  what it missed), or null when it is one. Shown text: made printable, and cut (said). */
export const branchRefusal = (value: unknown): string | null => {
  if (isBranch(value)) return null;
  const shown = `'${printable(value, 300)}'`;
  if (typeof value === "string" && characters(value) > NAMES.branch)
    return `${shown} is not a branch desolate will carry: ${over("it", NAMES.branch, characters(value), "characters")}`;
  return `${shown} is not a branch desolate will carry`;
};

declare namespace branchRefusal {
  /** what callers said before, and the bound by its number when that is what was missed */
  export type Says = Table<
    typeof branchRefusal,
    [
      [args: [value: "feature/x"], expected: null],
      [
        args: [value: "--upload-pack=x"],
        expected: "'--upload-pack=x' is not a branch desolate will carry",
      ],
      /** the control: at the bound, a branch */
      [args: [value: Invoke<typeof branchOf, [length: 200]>], expected: null],
    ]
  >;
  /** one past it: the bound, by its number */
  export type Long = Expect<
    Invoke<typeof branchRefusal, [value: Invoke<typeof branchOf, [length: 201]>]>,
    "includes",
    "is not a branch desolate will carry: it is 201 characters, over the 200 allowed"
  >;
}

declare namespace isBranch {
  /** a branch an agent may name and the root may carry: safe as an argv word and in a refspec */
  export type Carries = Table<
    typeof isBranch,
    [
      [args: [value: "main"], expected: true],
      [args: [value: "feature/greet-by-name"], expected: true],
      [args: [value: "v1.2_rc-3"], expected: true],
    ]
  >;
  export type Refuses = Table<
    typeof isBranch,
    [
      [args: [value: "--upload-pack=touch x"], expected: false],
      [args: [value: "a..b"], expected: false],
      [args: [value: "a//b"], expected: false],
      [args: [value: "feature/"], expected: false],
      [args: [value: "x.lock"], expected: false],
      [args: [value: "x@{1}"], expected: false],
      [args: [value: "a b"], expected: false],
      [args: [value: "a;rm -rf"], expected: false],
      [args: [value: ""], expected: false],
    ]
  >;
}

export const isCommit = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

declare namespace isCommit {
  /** a full object id, lower case: never an abbreviation, never a ref */
  export type Ids = Table<
    typeof isCommit,
    [
      [args: [value: "0123456789abcdef0123456789abcdef01234567"], expected: true],
      [args: [value: "0123456789ABCDEF0123456789ABCDEF01234567"], expected: false],
      [args: [value: "0123456"], expected: false],
      [args: [value: "HEAD"], expected: false],
    ]
  >;
}

/** GitHub's page for opening a pull request of `branch` into `base`, filled in: the person
 *  opens it in their own browser, signed in as themselves, and creates the pull request
 *  there. desolate holds no token that could. Null for anything that is not a repository and
 *  two branches, and for suede's `downstream/...` branches: the dependency's own Action
 *  opens that pull request, and a second one made from this link would be a duplicate
 *  (dogfooding: `desolate upstream` printed it beside "the Action opens the pull request"). */
export const pullRequestUrl = (
  repo: string,
  branch: string,
  base: string | null,
): string | null => {
  const r = parseRepo(repo);
  if (
    !r ||
    !isBranch(branch) ||
    !base ||
    !isBranch(base) ||
    base === branch ||
    branch.startsWith("downstream/")
  )
    return null;
  const part = (b: string) => b.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}/compare/${part(base)}...${part(branch)}?expand=1`;
};

declare namespace pullRequestUrl {
  /** a branch into its base, on GitHub; nothing for a branch into itself or a bad name */
  export type Links = Table<
    typeof pullRequestUrl,
    [
      [
        args: [repo: "acme/widgets", branch: "mac/push-label", base: "v3"],
        expected: "https://github.com/acme/widgets/compare/v3...mac/push-label?expand=1",
      ],
      [
        args: [repo: "acme/widgets", branch: "issue/12", base: "main"],
        expected: "https://github.com/acme/widgets/compare/main...issue/12?expand=1",
      ],
      [args: [repo: "acme/widgets", branch: "main", base: "main"], expected: null],
      [args: [repo: "acme/widgets", branch: "a..b", base: "main"], expected: null],
      [args: [repo: "acme/widgets", branch: "x", base: null], expected: null],
      [args: [repo: "not a repo", branch: "x", base: "main"], expected: null],
      [
        args: [
          repo: "acme/lib",
          branch: "downstream/acme/app-0123456789abcdef0123456789abcdef01234567",
          base: "main",
        ],
        expected: null,
      ],
    ]
  >;
}

export const isLfsOid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

declare namespace isLfsOid {
  /** an LFS object's id: a sha256, in full and in lower case, and so a safe file name */
  export type Ids = Table<
    typeof isLfsOid,
    [
      [
        args: [value: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"],
        expected: true,
      ],
      [
        args: [value: "2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824"],
        expected: false,
      ],
      [args: [value: "0123456789abcdef0123456789abcdef01234567"], expected: false],
      [
        args: [value: "../../2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b98"],
        expected: false,
      ],
    ]
  >;
}

/** An LFS pointer's object, when a blob is git-lfs's three lines exactly; else null, and it is
 *  an ordinary file. (A pointer with an extension line, which the spec allows, is taken as a
 *  file too: the forge then refuses the push that names its object.) */
export const lfsPointer = (blob: string): { oid: string; size: number } | null => {
  const m =
    /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n$/.exec(
      blob,
    );
  return m ? { oid: m[1]!, size: Number(m[2]) } : null;
};

declare namespace lfsPointer {
  /** the pointer, exactly: its oid and the size it says (an empty object's is 0) */
  export type Pointers = Table<
    typeof lfsPointer,
    [
      [
        args: [
          blob: "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12\n",
        ],
        expected: {
          oid: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
          size: 12;
        },
      ],
      [
        args: [
          blob: "version https://git-lfs.github.com/spec/v1\noid sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nsize 0\n",
        ],
        expected: {
          oid: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
          size: 0;
        },
      ],
    ]
  >;
  /** at each edge of the form, a file that only looks like one */
  export type NotPointers = Table<
    typeof lfsPointer,
    [
      /** its last newline missing, a line before it, a line after it, CR LF line ends */
      [
        args: [
          blob: "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12",
        ],
        expected: null,
      ],
      [
        args: [
          blob: "# notes\nversion https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12\n",
        ],
        expected: null,
      ],
      [
        args: [
          blob: "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12\nx-extra 1\n",
        ],
        expected: null,
      ],
      [
        args: [
          blob: "version https://git-lfs.github.com/spec/v1\r\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\r\nsize 12\r\n",
        ],
        expected: null,
      ],
      /** another spec, an extension line (which the spec allows: see above) */
      [
        args: [
          blob: "version https://git-lfs.github.com/spec/v2\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12\n",
        ],
        expected: null,
      ],
      [
        args: [
          blob: "version https://git-lfs.github.com/spec/v1\next-0-foo sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12\n",
        ],
        expected: null,
      ],
      /** an oid of 63 or 65 digits, in upper case, or a path: never a file name */
      [
        args: [
          blob: "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\nsize 12\n",
        ],
        expected: null,
      ],
      [
        args: [
          blob: "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0\nsize 12\n",
        ],
        expected: null,
      ],
      [
        args: [
          blob: "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef\nsize 12\n",
        ],
        expected: null,
      ],
      [
        args: [
          blob: "version https://git-lfs.github.com/spec/v1\noid sha256:../../../../etc/passwd\nsize 12\n",
        ],
        expected: null,
      ],
      /** a size that is not a number of bytes */
      [
        args: [
          blob: "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize \n",
        ],
        expected: null,
      ],
      [
        args: [
          blob: "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nsize -12\n",
        ],
        expected: null,
      ],
    ]
  >;
}

const hex = (text: string, length: number) =>
  createHash("sha256").update(text).digest("hex").slice(0, length);

/** VM names are short and opaque: Lima's socket paths cap at 104 bytes, and two slugs of 40
 *  would not fit. The readable name travels as a label. `instance` separates stacks on one
 *  host (a test run beside the real one). */
export const rootVmName = (instance: string) => `dsl-${instance}-root`;
/** The git VM (host/git-vm.ts): where the person types git, in clones of their own. */
export const gitVmName = (instance: string) => `dsl-${instance}-git`;
export const workspaceVmName = (instance: string, domain: string, workspace: string) =>
  `dsl-${instance}-${hex(`${domain}\0${workspace}`, 10)}`;

declare namespace rootVmName {
  /** one root VM per stack, named by its instance */
  export type Name = Expect<Invoke<typeof rootVmName, [instance: "t1"]>, "=", "dsl-t1-root">;
}
declare namespace gitVmName {
  /** one git VM per stack, likewise */
  export type Name = Expect<Invoke<typeof gitVmName, [instance: "t1"]>, "=", "dsl-t1-git">;
}
declare namespace workspaceVmName {
  /** short and opaque, the same for the same workspace every time; the domain and the
   *  workspace kept apart in what is hashed, so `a-b`'s `c` is not `a`'s `b-c` */
  export type Names = Table<
    typeof workspaceVmName,
    [
      [args: [instance: "t1", domain: "acme", workspace: "w1"], expected: "dsl-t1-ddb30a57cc"],
      [args: [instance: "t1", domain: "a-b", workspace: "c"], expected: "dsl-t1-695274f6b8"],
      [args: [instance: "t1", domain: "a", workspace: "b-c"], expected: "dsl-t1-02654a5c0c"],
    ]
  >;
}

/** One hostname per surface (section 4.4). The hex is not a secret: it keeps two stacks, or
 *  a recreated workspace, from sharing a cookie jar by name. */
export const surfaceHex = (instance: string, domain: string, workspace: string) =>
  hex(`${instance}\0${domain}\0${workspace}`, 6);
/** What this stack's names end in: `localhost`, or, for a stack run inside a desolate
 *  workspace (developing desolate there), that workspace's own dev name: the outer stack
 *  routes it and every name under it to that workspace (host/daemon.ts), and a browser on the
 *  Mac resolves every `*.localhost` name to loopback. Inside the workspace, the outer stack
 *  gives it as DESOLATE_DEV_HOSTNAME:
 *    DESOLATE_HOSTNAME_SUFFIX=$DESOLATE_DEV_HOSTNAME desolate bootstrap
 *  Everything under it is that workspace's (its domain's), the inner stack's pages included. */
export const isLocalhostSuffix = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 120 &&
  /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*localhost$/.test(value);
export const HOSTNAME_SUFFIX = (() => {
  const value = process.env.DESOLATE_HOSTNAME_SUFFIX || "localhost";
  if (!isLocalhostSuffix(value))
    throw new Error(
      `DESOLATE_HOSTNAME_SUFFIX must be localhost or a name under it, not '${value}'`,
    );
  return value;
})();
export const devHostname = (instance: string, domain: string, workspace: string) =>
  `${domain}-${workspace}-${surfaceHex(instance, domain, workspace)}.${HOSTNAME_SUFFIX}`;
export const editorHostname = (instance: string, domain: string, workspace: string) =>
  `${domain}-${workspace}-editor-${surfaceHex(instance, domain, workspace)}.${HOSTNAME_SUFFIX}`;

declare namespace devHostname {
  /** a workspace's dev servers: readable, and a hex that keeps another stack's apart */
  export type Name = Expect<
    Invoke<typeof devHostname, [instance: "t1", domain: "acme", workspace: "w1"]>,
    "=",
    "acme-w1-96fd85.localhost"
  >;
}
declare namespace editorHostname {
  /** its editor: the same hex, a name of its own, so the two share no cookies */
  export type Name = Expect<
    Invoke<typeof editorHostname, [instance: "t1", domain: "acme", workspace: "w1"]>,
    "=",
    "acme-w1-editor-96fd85.localhost"
  >;
}
export const ROOT_HOSTNAME = `desolate.${HOSTNAME_SUFFIX}`;
/** The approval page (host/approve-web.ts), served by the host daemon itself on the editors'
 *  port. A name of its own, not under ROOT_HOSTNAME: the dashboard's content comes from the
 *  root, and a cookie it set for its own domain would be sent to names under it. */
export const APPROVE_HOSTNAME = `desolate-approve.${HOSTNAME_SUFFIX}`;
/** The git terminal (host/git-web.ts): a bash in the git VM, in a browser tab. */
export const GIT_HOSTNAME = `desolate-git.${HOSTNAME_SUFFIX}`;

/** A workspace's editor (P1: it runs in the workspace VM). In the VM, the editor's server
 *  listens on loopback at `server`, and editor-gate.ts in front of it at `gate`; the host's
 *  forwarder reaches only the gate, on one host port, by the editor's own hostname. Neither
 *  in-VM port is ever forwarded as a dev-server port. */
export const EDITOR = { server: 31580, gate: 31581 } as const;
export const EDITOR_PORT = define({
  name: "editor.port",
  env: "DESOLATE_EDITOR_PORT",
  side: "host",
  default: EDITOR.gate,
  parse: whole(PORTS.min, PORTS.max),
  why: "The one port on this Mac for every editor, the dashboard and the approval page: another, for a second stack beside the first.",
});
export const editorHostPort = () => valueOf(EDITOR_PORT);

declare namespace editorHostPort {
  /** the gate's own port unless the person moves it */
  export type Default = Given<
    Invoke<typeof setEnv, [name: "DESOLATE_EDITOR_PORT", value: null]>,
    Expect<Invoke<typeof editorHostPort>, "=", 31581>
  >;
  /** or another, for a second stack beside the first */
  export type Moved = Given<
    Invoke<typeof setEnv, [name: "DESOLATE_EDITOR_PORT", value: "41581"]>,
    Expect<Invoke<typeof editorHostPort>, "=", 41581>
  >;
  /** a port that needs root, or is not a port: refused, saying what was given */
  export type Refuses = [
    Given<
      Invoke<typeof setEnv, [name: "DESOLATE_EDITOR_PORT", value: "80"]>,
      Throws<
        Invoke<typeof editorHostPort>,
        "DESOLATE_EDITOR_PORT must be a whole number from 1024 to 65535, not '80'"
      >
    >,
    Given<
      Invoke<typeof setEnv, [name: "DESOLATE_EDITOR_PORT", value: "31581x"]>,
      Throws<Invoke<typeof editorHostPort>, "not '31581x'">
    >,
  ];
}

/** The root UI: the state service in the root VM, which serves the dashboard. It is on the
 *  root VM's loopback; the host's forwarder carries it on the editors' port, at
 *  ROOT_HOSTNAME. (The root has no editor: nothing in the root opens what an agent wrote
 *  with anything but git and desolate's own code.) */
export const ROOT_UI = { port: 31590 } as const;

declare namespace isLocalhostSuffix {
  /** localhost, or names under it: never another domain, a port or anything a URL could escape by */
  export type Names = Table<
    typeof isLocalhostSuffix,
    [
      [args: [value: "localhost"], expected: true],
      [args: [value: "acme--app-w1-0a1b2c.localhost"], expected: true],
      [args: [value: "example.com"], expected: false],
      [args: [value: "localhost.example.com"], expected: false],
      [args: [value: "a.localhost:80"], expected: false],
      [args: [value: "A.localhost"], expected: false],
      [args: [value: ".localhost"], expected: false],
    ]
  >;
}
