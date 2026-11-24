// clone, fetch, repos, keys: the host's part. The root makes keys and fetches; the host only
// registers the public halves with the forge, using the person's own credentials there.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXIT, refuse } from "../shared/exit.ts";
import { domainNameFor, isSlug, parseRepo, repoId } from "../shared/names.ts";
import { run } from "../shared/run.ts";
import { INSTANCE } from "./paths.ts";
import { backend, config, ensureProxyUser, ROOT_VM, rootctl } from "./stack.ts";
import type {
  Expect,
  Given,
  Invoke,
  Mock,
  Table,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { collect, fakeStack, rootAnswers, rootAsked, said } from "../.harness/host-stack.ts";
import type { forgeAdmin, forgeGot, keyringHolds, standInStack } from "../.harness/host-repos.ts";
import type { refusalOf } from "../.harness/refusal.ts";

type Out = (line: string) => void;
type Role = "read" | "write";
type Key = { role: Role; pubkey: string };

/** An ed25519 public key as ssh-keygen writes one: one line, its type, its base64, and at most
 *  a comment of visible characters. */
const PUBKEY = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [\x21-\x7e]{1,200})?$/;

/** A key file's text, if it is one public key (one line, its newline optional): the whole
 *  line, and the key alone (its type and base64, what a forge is given), else null. */
export const publicKey = (text: string): { line: string; key: string } | null => {
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!PUBKEY.test(line)) return null;
  return { line, key: line.split(" ").slice(0, 2).join(" ") };
};

declare namespace publicKey {
  /** one key, with or without its comment, is taken; anything else in the file is refused */
  export type Lines = Table<
    typeof publicKey,
    [
      [
        args: [text: "ssh-ed25519 AAAAC3Nz+/9= desolate-read:acme/web\n"],
        expected: {
          line: "ssh-ed25519 AAAAC3Nz+/9= desolate-read:acme/web";
          key: "ssh-ed25519 AAAAC3Nz+/9=";
        },
      ],
      [
        args: [text: "ssh-ed25519 AAAAC3Nz"],
        expected: { line: "ssh-ed25519 AAAAC3Nz"; key: "ssh-ed25519 AAAAC3Nz" },
      ],
      [args: [text: "ssh-ed25519 AAAAone a\nssh-ed25519 AAAAtwo b\n"], expected: null],
      [args: [text: "ssh-ed25519 AAAAone a\n\n"], expected: null],
      [args: [text: "ssh-ed25519 AAAAone a b"], expected: null],
      [args: [text: "ssh-ed25519 AAAAone \u001b[2Jcleared"], expected: null],
      [args: [text: "ssh-rsa AAAAone"], expected: null],
      [args: [text: ""], expected: null],
    ]
  >;
}

/** A key's public half, read by the Mac itself, as root in the root VM, from the keyring's own
 *  file (root/keyring.ts's keyFile, under root/layout.ts's KEYRING.keys). The root's ordinary
 *  user, which parses what domains send, answers rootctl: what it says a key is, is never what
 *  a forge is given or a person is shown. */
const keyringKey = async (repo: string, role: Role) => {
  const file = `/var/lib/desolate-root/keyring/${repo}/${role}.pub`;
  const read = await backend().exec(ROOT_VM, ["cat", "--", file], {
    root: true,
    maxBytes: 4096,
    timeoutMs: 20_000,
  });
  const key = read.code === 0 ? publicKey(read.stdout) : null;
  if (!key)
    refuse(
      `the root VM's keyring gave something that is not a public key for ${repo}'s ${role} key`,
      "desolate doctor",
    );
  return key!;
};

const repoArg = (value: string | undefined) =>
  parseRepo(value) ?? refuse(`'${value ?? ""}' is not a repository`, "name it as <owner>/<repo>");

/** Register one deploy key. GitHub: the person's `gh`. Stand-in: the command in
 *  DESOLATE_FORGE_ADMIN (tests). Read keys are read-only; write keys read-write. */
const register = async (repo: string, key: Key) => {
  const forge = config()!.forge;
  if (forge.kind === "stand-in") {
    const admin = process.env.DESOLATE_FORGE_ADMIN;
    if (!admin)
      refuse(
        "the stand-in forge needs its admin command to register a key",
        "set DESOLATE_FORGE_ADMIN to the forge's admin script",
      );
    const result = await run(admin!, ["add-key", repo, key.role, key.pubkey]);
    if (result.code !== 0)
      throw new Error(`the stand-in forge refused the ${key.role} key: ${result.stderr.trim()}`);
    return "registered";
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-key-"));
  const file = path.join(dir, "key.pub");
  fs.writeFileSync(file, key.pubkey + "\n", { mode: 0o600 });
  try {
    // The title is seen by everyone who administers the repository. A Mac's hostname is
    // often its owner's name ("Someones-MacBook-Pro"), so the host is named by a hash of it:
    // enough to tell two machines' keys apart, nothing about who owns them.
    const host = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 8);
    const args = [
      "repo",
      "deploy-key",
      "add",
      file,
      "--repo",
      repo,
      "--title",
      `desolate ${key.role} (host ${host}, ${INSTANCE})`,
    ];
    if (key.role === "write") args.push("--allow-write");
    const result = await run("gh", args);
    if (result.code === 0) return "registered";
    if (/already in use|already exists/i.test(result.stderr)) return "already registered";
    if (result.code === 127)
      refuse(
        "registering a deploy key needs GitHub's CLI",
        "install gh and run `gh auth login`, or add this key to the repository's deploy keys by hand:\n" +
          key.pubkey,
      );
    refuse(
      `GitHub refused the ${key.role} deploy key for ${repo}: ${result.stderr.trim().split("\n").pop()}`,
      `if someone else administers ${repo}, they can add the keys: desolate clone ${repo} --keys-by-hand prints them. Otherwise: ${key.role === "write" ? "--no-push (no write key), or " : ""}--anonymous (no key, a public repository)`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return "registered";
};

/** The domain a clone lands in: the one named (made if it is new), or `owner--repo`, made
 *  for it. A domain that already holds the repository is reused, so a
 *  second clone changes nothing. */
const domainFor = async (
  repo: string,
  named: string | undefined,
): Promise<{ slug: string; made: boolean; added: boolean } | { taken: string[] }> => {
  const existing = await rootctl("domain.list", {}, { quiet: true });
  const holding = (slug: string) => existing.find((d) => d.slug === slug);
  const join = async (slug: string) => {
    const there = holding(slug);
    if (there?.repos.includes(repo)) return { slug, made: false, added: false };
    if (!there) {
      await rootctl("domain.create", { slug, title: repo }, { quiet: true });
      await ensureProxyUser(slug);
    }
    await rootctl("domain.add-repo", { slug, repo }, { quiet: true });
    return { slug, made: !there, added: true };
  };
  if (named !== undefined) return join(named);
  const slug = domainNameFor(repoArg(repo));
  if (!holding(slug) || holding(slug)!.repos.includes(repo)) return join(slug);
  return { taken: [slug] };
};

export const clone = async (
  name: string | undefined,
  options: { push: boolean; anonymous: boolean; domain?: string | false; byHand?: boolean },
  out: Out,
  json: boolean,
) => {
  const repo = repoId(repoArg(name));
  if (typeof options.domain === "string" && !isSlug(options.domain))
    refuse(
      `'${options.domain}' is not a domain name`,
      "a domain name is a slug: lowercase letters, digits and single dashes, at most 40",
      EXIT.usage,
    );
  // The keys are the ones asked for, as root/repos.ts's prepare makes them: a read key unless
  // anonymous, a write key only to push.
  const roles: Role[] = [
    ...(options.anonymous ? [] : (["read"] as const)),
    ...(options.push ? (["write"] as const) : []),
  ];
  // It makes the keys: the ones asked for, or a refusal (replies.ts). What it says they are is
  // not used (keyringKey).
  const prepared = await rootctl("repo.prepare", {
    repo,
    push: options.push,
    anonymous: options.anonymous,
  });
  const made: Key[] = [];
  for (const role of roles) made.push({ role, pubkey: (await keyringKey(repo, role)).key });
  if (options.byHand) {
    // Keys added by whoever administers the repository (GitHub: Settings, Deploy keys). The
    // root made them and keeps them; only their public halves are shown. The fetch says
    // whether the read key is in place yet; the write key is first used by a push you approve.
    const tried = await rootctl("repo.fetch", { repo }, { quiet: true }).catch(() => null);
    if (!tried) {
      out(
        `Add ${made.length === 1 ? "this deploy key" : "these deploy keys"} to ${repo}${config()?.forge.kind === "github" ? ` (https://github.com/${repo}/settings/keys/new)` : ""}, then run this command again:`,
      );
      for (const key of made)
        out(
          `\n  ${key.role === "write" ? 'desolate write: tick "Allow write access"' : "desolate read: read-only"}\n  ${key.pubkey}`,
        );
      return out(
        "\nOnly public halves are shown: the private ones never leave the root's keyring.",
      );
    }
    if (!json)
      out(
        `  keys: added by hand; the read key works${prepared.pushable ? " (the write key is first used by a push you approve)" : ""}`,
      );
  } else
    for (const key of made) {
      const how = await register(repo, key);
      if (!json)
        out(
          `  ${key.role} key: ${how}${key.role === "write" ? " (it asks you before every push)" : ""}`,
        );
    }
  const fetched = await rootctl("repo.fetch", { repo });
  const placed = options.domain === false ? null : await domainFor(repo, options.domain);
  const domain = placed && "slug" in placed ? placed : null;
  if (json)
    return out(
      JSON.stringify({
        ...prepared,
        keys: roles,
        ...fetched,
        domain: domain?.slug ?? null,
      }),
    );
  out(
    `cloned ${repo}: ${fetched.branches} branch(es), default ${fetched.defaultBranch ?? "none"}, ${fetched.lfsObjects} LFS object(s); ${prepared.pushable ? "pushable" : prepared.anonymous ? "read-only, fetched anonymously" : "read-only (no write key)"}.`,
  );
  if (domain) {
    out(
      domain.made
        ? `domain ${domain.slug}: made for ${repo}.`
        : domain.added
          ? `domain ${domain.slug}: ${repo} added.`
          : `domain ${domain.slug}: already holds ${repo}.`,
    );
    return out(
      `next: desolate up ${domain.slug}   (a workspace: a VM with its checkout, its devcontainer and an editor)`,
    );
  }
  if (placed && "taken" in placed)
    out(
      `no domain was made: ${placed.taken.join(" and ")} is a domain already, holding other repositories.`,
    );
  out(
    `next: desolate domain create <slug> --repo ${repo}   (or, to a domain you have: desolate domain <slug> add --repo ${repo}; or clone again with --domain <slug>)`,
  );
};

declare namespace clone {
  type Anonymous = { push: false; anonymous: true };
  type Fetched = {
    repo: "acme/web";
    branches: 3;
    defaultBranch: "main";
    lfsObjects: 0;
    rootClone: "created";
  };
  /** names that become paths and VM labels are checked before the root is asked anything */
  export type Refuses = Given<
    [Mock<"./stack.ts", typeof fakeStack>, Invoke<typeof rootAnswers, [answers: {}]>],
    [
      Expect<
        Invoke<
          typeof refusalOf,
          [
            run: typeof clone,
            args: [name: "acme", options: Anonymous, out: typeof collect, json: false],
          ]
        >,
        "=",
        { message: "'acme' is not a repository"; fix: "name it as <owner>/<repo>"; code: 1 }
      >,
      Expect<
        Invoke<
          typeof refusalOf,
          [
            run: typeof clone,
            args: [
              name: "acme/web",
              options: { push: false; anonymous: true; domain: "../acme" },
              out: typeof collect,
              json: false,
            ],
          ]
        >,
        "matches",
        { message: "'../acme' is not a domain name"; code: 64 }
      >,
      Expect<Invoke<typeof rootAsked>, "=", []>,
    ]
  >;
  /** a repository gets a domain of its own, owner--repo, made for it */
  export type MakesItsDomain = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<
        typeof rootAnswers,
        [
          answers: {
            "repo.prepare": { repo: "acme/web"; pushable: false; anonymous: true; keys: [] };
            "repo.fetch": Fetched;
            "domain.list": [];
            "domain.create": {
              slug: "acme--web";
              title: "acme/web";
              repos: [];
              createdAt: "2026-11-16T09:00:00Z";
            };
            "domain.add-repo": { domain: "acme--web"; repo: "acme/web"; added: true; note: "" };
          },
        ]
      >,
      Invoke<
        typeof clone,
        [name: "acme/web", options: Anonymous, out: typeof collect, json: false]
      >,
    ],
    Expect<
      Invoke<typeof said>,
      "=",
      [
        "cloned acme/web: 3 branch(es), default main, 0 LFS object(s); read-only, fetched anonymously.",
        "domain acme--web: made for acme/web.",
        "next: desolate up acme--web   (a workspace: a VM with its checkout, its devcontainer and an editor)",
      ]
    >
  >;
  /** a domain of that name that holds other repositories is not joined: it is another's */
  export type NameTaken = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<
        typeof rootAnswers,
        [
          answers: {
            "repo.prepare": { repo: "acme/web"; pushable: false; anonymous: true; keys: [] };
            "repo.fetch": Fetched;
            "domain.list": [
              {
                slug: "acme--web";
                title: "acme--web";
                repos: ["acme/other"];
                createdAt: "2026-11-16T09:00:00Z";
                workspaces: [];
              },
            ];
          },
        ]
      >,
      Invoke<
        typeof clone,
        [name: "acme/web", options: Anonymous, out: typeof collect, json: false]
      >,
    ],
    Expect<
      Invoke<typeof said>,
      "=",
      [
        "cloned acme/web: 3 branch(es), default main, 0 LFS object(s); read-only, fetched anonymously.",
        "no domain was made: acme--web is a domain already, holding other repositories.",
        "next: desolate domain create <slug> --repo acme/web   (or, to a domain you have: desolate domain <slug> add --repo acme/web; or clone again with --domain <slug>)",
      ]
    >
  >;
  /** keys someone else adds: their public halves as the keyring holds them, until the root can
   *  fetch with the read key */
  export type KeysByHand = Given<
    [
      Mock<"./stack.ts", typeof standInStack>,
      Invoke<
        typeof rootAnswers,
        [
          answers: {
            "repo.prepare": {
              repo: "acme/web";
              pushable: true;
              anonymous: false;
              keys: [
                { role: "read"; pubkey: "ssh-ed25519 AAAAroots" },
                { role: "write"; pubkey: "ssh-ed25519 AAAAroots" },
              ];
            };
          },
        ]
      >,
      Invoke<typeof keyringHolds, [files: Keyring]>,
      Invoke<
        typeof clone,
        [
          name: "acme/web",
          options: { push: true; anonymous: false; byHand: true },
          out: typeof collect,
          json: false,
        ]
      >,
    ],
    Expect<
      Invoke<typeof said>,
      "=",
      [
        "Add these deploy keys to acme/web, then run this command again:",
        "",
        "  desolate read: read-only",
        "  ssh-ed25519 AAAAread",
        "",
        '  desolate write: tick "Allow write access"',
        "  ssh-ed25519 AAAAwrite",
        "",
        "Only public halves are shown: the private ones never leave the root's keyring.",
      ]
    >
  >;
  type Keyring = {
    "/var/lib/desolate-root/keyring/acme/web/read.pub": "ssh-ed25519 AAAAread desolate-read:acme/web\n";
    "/var/lib/desolate-root/keyring/acme/web/write.pub": "ssh-ed25519 AAAAwrite desolate-write:acme/web\n";
  };
  type ReadOnly = { push: false; anonymous: false; domain: false };
  type Prepared<K> = {
    "repo.prepare": { repo: "acme/web"; pushable: false; anonymous: false; keys: K };
    "repo.fetch": Fetched;
  };
  /** the forge is given the keyring's read key, without its comment, and nothing else */
  export type Registers = Given<
    [
      Mock<"./stack.ts", typeof standInStack>,
      Invoke<
        typeof rootAnswers,
        [
          answers: Prepared<
            [{ role: "read"; pubkey: "ssh-ed25519 AAAAread desolate-read:acme/web" }]
          >,
        ]
      >,
      Invoke<typeof keyringHolds, [files: Keyring]>,
      Invoke<typeof forgeAdmin>,
      Invoke<typeof clone, [name: "acme/web", options: ReadOnly, out: typeof collect, json: false]>,
    ],
    [
      Expect<Invoke<typeof forgeGot>, "=", ["add-key acme/web read ssh-ed25519 AAAAread"]>,
      Expect<
        Invoke<typeof said>,
        "=",
        [
          "  read key: registered",
          "cloned acme/web: 3 branch(es), default main, 0 LFS object(s); read-only (no write key).",
          "next: desolate domain create <slug> --repo acme/web   (or, to a domain you have: desolate domain <slug> add --repo acme/web; or clone again with --domain <slug>)",
        ]
      >,
    ]
  >;
  /** a key the root's answer makes up is not what the forge is given: the keyring's is */
  export type NotTheAnswersKey = Given<
    [
      Mock<"./stack.ts", typeof standInStack>,
      Invoke<
        typeof rootAnswers,
        [answers: Prepared<[{ role: "read"; pubkey: "ssh-ed25519 AAAAroots" }]>]
      >,
      Invoke<typeof keyringHolds, [files: Keyring]>,
      Invoke<typeof forgeAdmin>,
      Invoke<typeof clone, [name: "acme/web", options: ReadOnly, out: typeof collect, json: false]>,
    ],
    Expect<Invoke<typeof forgeGot>, "=", ["add-key acme/web read ssh-ed25519 AAAAread"]>
  >;
  /** a write key the --no-push clone did not ask for is refused, and the forge is given nothing */
  export type WriteNotAsked = Given<
    [
      Mock<"./stack.ts", typeof standInStack>,
      Invoke<
        typeof rootAnswers,
        [
          answers: Prepared<
            [
              { role: "read"; pubkey: "ssh-ed25519 AAAAroots" },
              { role: "write"; pubkey: "ssh-ed25519 AAAAroots" },
            ]
          >,
        ]
      >,
      Invoke<typeof keyringHolds, [files: Keyring]>,
      Invoke<typeof forgeAdmin>,
    ],
    [
      Expect<
        Invoke<
          typeof refusalOf,
          [
            run: typeof clone,
            args: [name: "acme/web", options: ReadOnly, out: typeof collect, json: false],
          ]
        >,
        "=",
        {
          message: "the root answered for other keys than the ones asked for acme/web, so none was registered";
          fix: "desolate doctor";
          code: 1;
        }
      >,
      Expect<Invoke<typeof forgeGot>, "=", []>,
    ]
  >;
  /** a keyring file of two lines is not a key: refused, and the forge is given nothing */
  export type NotAKey = Given<
    [
      Mock<"./stack.ts", typeof standInStack>,
      Invoke<
        typeof rootAnswers,
        [answers: Prepared<[{ role: "read"; pubkey: "ssh-ed25519 AAAAread" }]>]
      >,
      Invoke<
        typeof keyringHolds,
        [
          files: {
            "/var/lib/desolate-root/keyring/acme/web/read.pub": "ssh-ed25519 AAAAread a\nssh-ed25519 AAAAother b\n";
          },
        ]
      >,
      Invoke<typeof forgeAdmin>,
    ],
    [
      Expect<
        Invoke<
          typeof refusalOf,
          [
            run: typeof clone,
            args: [name: "acme/web", options: ReadOnly, out: typeof collect, json: false],
          ]
        >,
        "=",
        {
          message: "the root VM's keyring gave something that is not a public key for acme/web's read key";
          fix: "desolate doctor";
          code: 1;
        }
      >,
      Expect<Invoke<typeof forgeGot>, "=", []>,
    ]
  >;
}

export const fetch = async (name: string | undefined, out: Out, json: boolean) => {
  const repo = repoId(repoArg(name));
  const fetched = await rootctl("repo.fetch", { repo });
  out(
    json
      ? JSON.stringify(fetched)
      : `fetched ${repo}: ${fetched.branches} branch(es), ${fetched.lfsObjects} LFS object(s) in the mirror.`,
  );
};

export const repos = async (out: Out, json: boolean) => {
  const list = await rootctl("repo.list", {}, { quiet: true });
  if (json) return out(JSON.stringify(list));
  if (list.length === 0)
    return out("no repositories yet. Start with: desolate clone <owner>/<repo>");
  for (const r of list)
    out(
      `${r.repo}  ${r.pushable ? "pushable" : r.anonymous ? "read-only (anonymous)" : "read-only"}  default ${r.defaultBranch ?? "?"}  fetched ${r.fetchedAt ?? "never"}`,
    );
};

/** The keys the root holds, and a key's public half, for adding it to a forge by hand. */
export const keys = async (name: string | undefined, out: Out, json: boolean) => {
  const held = await rootctl("keys.list", {}, { quiet: true });
  if (!name) {
    if (json) return out(JSON.stringify(held));
    if (held.length === 0)
      return out(
        "the root holds no keys yet. `desolate clone <owner>/<repo>` makes a repository's.",
      );
    for (const key of held)
      out(
        `${key.repo}  ${key.role}${key.role === "write" ? "  (asks you before every push)" : ""}`,
      );
    return out("a key's public half: desolate keys <owner>/<repo>");
  }
  const repo = repoId(repoArg(name));
  const mine = held.filter((key) => key.repo === repo);
  if (mine.length === 0) refuse(`the root holds no key for ${repo}`, `desolate clone ${repo}`);
  const shown: { role: string; pubkey: string }[] = [];
  // Read from the keyring itself, as clone's are; shown whole, comment and all, which names
  // the repository it is for. (A role is read or write, or the list is refused: replies.ts.)
  for (const key of mine)
    shown.push({ role: key.role, pubkey: (await keyringKey(repo, key.role)).line });
  if (json) return out(JSON.stringify(shown));
  for (const key of shown)
    out(
      `${repo}  ${key.role} key (a deploy key${key.role === "write" ? " with write access" : ", read-only"}):\n  ${key.pubkey}`,
    );
  out("Only public halves are ever shown: the private halves do not leave the root's keyring.");
};

declare namespace keys {
  /** a key's public half, only for a repository the root holds a key for */
  export type NoneHeld = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<typeof rootAnswers, [answers: { "keys.list": [{ repo: "acme/api"; role: "read" }] }]>,
    ],
    Expect<
      Invoke<
        typeof refusalOf,
        [run: typeof keys, args: [name: "acme/web", out: typeof collect, json: false]]
      >,
      "=",
      { message: "the root holds no key for acme/web"; fix: "desolate clone acme/web"; code: 1 }
    >
  >;
  /** a key's public half is the keyring's own, whatever else the root's user would say */
  export type Shows = Given<
    [
      Mock<"./stack.ts", typeof standInStack>,
      Invoke<
        typeof rootAnswers,
        [
          answers: {
            "keys.list": [{ repo: "acme/web"; role: "read" }];
            "keys.pubkey": { pubkey: "ssh-ed25519 AAAAroots" };
          },
        ]
      >,
      Invoke<
        typeof keyringHolds,
        [
          files: {
            "/var/lib/desolate-root/keyring/acme/web/read.pub": "ssh-ed25519 AAAAread desolate-read:acme/web\n";
          },
        ]
      >,
      Invoke<typeof keys, [name: "acme/web", out: typeof collect, json: false]>,
    ],
    Expect<
      Invoke<typeof said>,
      "=",
      [
        "acme/web  read key (a deploy key, read-only):",
        "  ssh-ed25519 AAAAread desolate-read:acme/web",
        "Only public halves are ever shown: the private halves do not leave the root's keyring.",
      ]
    >
  >;
  /** a role that is neither read nor write names no file of the keyring's: refused */
  export type OtherRole = Given<
    [
      Mock<"./stack.ts", typeof standInStack>,
      Invoke<
        typeof rootAnswers,
        [answers: { "keys.list": [{ repo: "acme/web"; role: "../read" }] }]
      >,
    ],
    Expect<
      Invoke<
        typeof refusalOf,
        [run: typeof keys, args: [name: "acme/web", out: typeof collect, json: false]]
      >,
      "matches",
      { message: "the root's answer to 'keys.list' is not in the form this Mac takes ([0].role)" }
    >
  >;
  /** which keys the root holds; a write key asks before every push */
  export type Lists = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<
        typeof rootAnswers,
        [
          answers: {
            "keys.list": [{ repo: "acme/web"; role: "read" }, { repo: "acme/web"; role: "write" }];
          },
        ]
      >,
      Invoke<typeof keys, [name: undefined, out: typeof collect, json: false]>,
    ],
    Expect<
      Invoke<typeof said>,
      "=",
      [
        "acme/web  read",
        "acme/web  write  (asks you before every push)",
        "a key's public half: desolate keys <owner>/<repo>",
      ]
    >
  >;
}
