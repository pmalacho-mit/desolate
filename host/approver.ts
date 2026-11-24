// The approver: the one thing that can approve a push, and it is on the host, outside every
// VM (P2, P5). It holds a signing key; the root's keyring files an approval only for a
// challenge this key signed (root/keyring.ts, shared/approval.ts).
//
// WHAT THE GATE IS FOR. desolate's rule is that nothing untrusted runs on the host or in the
// root VM: both hold what is sensitive, as any developer's machine does. Under that rule the
// approval is not a wall against an attacker on the host. It is what tells "a person decided
// to push this commit" from "a script ran a command": well-meaning automation stops here.
//
// Two kinds, chosen once at bootstrap and recorded:
//   terminal  (the default) a software key in ~/.desolate/approver, mode 0600. It signs
//             after the branch name is typed on this process's controlling terminal. It
//             does not stop a program running as you on the host, which can read the key
//             file or fabricate a terminal: that program is outside desolate's rule.
//   touchid   (macOS, opt-in: the setting approver.kind at the first bootstrap) the key is
//             in the Secure Enclave and signs only with the person present. For a stricter
//             stance than the rule above. It is a whole defence only together with a write
//             key that is also out of reach (docs/v3/decisions.md, section 5.3), and it has
//             never been compiled or run.
import { spawnSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signWith,
  verify,
} from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatSigned, parseSigned } from "../shared/approval.ts";
import { EXIT, Refusal, refuse } from "../shared/exit.ts";
import { formatBytes } from "../shared/limits.ts";
import { define, valueOf } from "../shared/settings.ts";
import { printable } from "../shared/text.ts";
import { paths, RELEASE_DIR } from "./paths.ts";
import type { Expect, Given, Invoke, Throws } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { emptyHome } from "../.harness/home.ts";
import type { keyringTakes, modeOf, writeInHome } from "../.harness/host-approver.ts";
import type { setEnv } from "../.harness/env.ts";
import type { collect } from "../.harness/host-stack.ts";
import type { refusalOf } from "../.harness/refusal.ts";

export type Kind = "touchid" | "terminal";
const DIR = path.join(paths.home, "approver");
const FILES = {
  kind: path.join(DIR, "kind"),
  pub: path.join(DIR, "approver.pub"),
  key: path.join(DIR, "key"),
  helper: path.join(DIR, "desolate-touchid"),
} as const;

/** Which kind the first bootstrap makes. */
export const APPROVER_KIND = define<Kind>({
  name: "approver.kind",
  env: "DESOLATE_APPROVER",
  side: "host",
  default: "terminal",
  parse: Object.assign(
    (text: string) =>
      ["touchid", "terminal"].includes(text.trim()) ? (text.trim() as Kind) : null,
    { takes: "touchid or terminal" },
  ),
  why: "Which key approves pushes: terminal (a software key; you type the branch) or touchid (the Secure Enclave, behind Touch ID).",
});

export const kind = (): Kind | null => {
  try {
    const value = fs.readFileSync(FILES.kind, "utf8").trim();
    return value === "touchid" || value === "terminal" ? value : null;
  } catch {
    return null;
  }
};
declare namespace kind {
  /** the kind bootstrap wrote is the kind: the control for the two below */
  export type Named = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof writeInHome, [name: "approver/kind", text: "terminal\n"]>,
    ],
    Expect<Invoke<typeof kind>, "=", "terminal">
  >;
  /** none until bootstrap makes one; a kind file that names neither kind is none */
  export type NoneYet = Given<
    Invoke<typeof emptyHome>,
    [Expect<Invoke<typeof kind>, "=", null>, Expect<Invoke<typeof publicKey>, "=", null>]
  >;
  export type NotAKind = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof writeInHome, [name: "approver/kind", text: "yubikey\n"]>,
    ],
    Expect<Invoke<typeof kind>, "=", null>
  >;
}
export const publicKey = (): string | null => {
  try {
    return createPublicKey(fs.readFileSync(FILES.pub, "utf8"))
      .export({ type: "spki", format: "pem" })
      .toString();
  } catch {
    return null;
  }
};
export const fingerprint = (pem: string) => createHash("sha256").update(pem).digest("hex");

/** Make the approver if there is none. Returns whether it made one. Which kind: `terminal`,
 *  unless approver.kind asks for the Secure Enclave (touchid). If that was asked for and
 *  cannot be set up, this refuses: the stronger kind is never quietly swapped for the
 *  other (P6). */
export const init = (log: (line: string) => void): boolean => {
  if (kind() && publicKey()) return false;
  const chosen = valueOf(APPROVER_KIND);
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DIR, 0o700);
  if (chosen === "touchid") {
    const weaker =
      "or use the default approver: desolate settings set approver.kind terminal, and bootstrap again";
    if (process.platform !== "darwin")
      refuse("the touchid approver needs a Mac", "desolate settings set approver.kind terminal");
    const built = spawnSync(
      "swiftc",
      ["-O", "-o", FILES.helper, path.join(RELEASE_DIR, "host", "approver", "touchid.swift")],
      { encoding: "utf8" },
    );
    if (built.status !== 0)
      refuse(
        `the Touch ID approver did not compile: ${(built.stderr || String(built.error ?? "")).trim().split("\n").slice(-3).join(" | ")}`,
        `install the Xcode command line tools (xcode-select --install) and bootstrap again; ${weaker}`,
      );
    const made = spawnSync(FILES.helper, ["init", FILES.key], { encoding: "utf8" });
    if (made.status !== 0 || !made.stdout.includes("BEGIN PUBLIC KEY"))
      refuse(`the Secure Enclave did not make a key: ${made.stderr.trim()}`, weaker);
    fs.writeFileSync(FILES.pub, made.stdout, { mode: 0o644 });
    log(
      "approver: a Secure Enclave key; every push will ask for Touch ID (or your login password)",
    );
  } else {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    fs.writeFileSync(FILES.key, pair.privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
    });
    fs.writeFileSync(FILES.pub, pair.publicKey.export({ type: "spki", format: "pem" }), {
      mode: 0o644,
    });
    log(`approver: a software key in ${DIR}; every push will ask on your terminal`);
  }
  fs.writeFileSync(FILES.kind, `${chosen}\n`, { mode: 0o644 });
  return true;
};

declare namespace init {
  /** the default: a software key, readable by this user only, made once */
  export type TerminalKey = Given<
    [Invoke<typeof emptyHome>, Invoke<typeof setEnv, [name: "DESOLATE_APPROVER", value: null]>],
    [
      Expect<Invoke<typeof init, [log: typeof collect]>, "=", true>,
      Expect<Invoke<typeof kind>, "=", "terminal">,
      Expect<Invoke<typeof modeOf, [name: "approver/key"]>, "=", 384>,
      Expect<Invoke<typeof init, [log: typeof collect]>, "=", false>,
    ]
  >;
  /** a kind asked for by a name it does not know is refused, never read as the default */
  export type UnknownKind = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof setEnv, [name: "DESOLATE_APPROVER", value: "yubikey"]>,
    ],
    Expect<
      Invoke<typeof refusalOf, [run: typeof init, args: [log: typeof collect]]>,
      "=",
      {
        message: "DESOLATE_APPROVER must be touchid or terminal, not 'yubikey'";
        fix: "unset DESOLATE_APPROVER (or set it to what it takes)";
        code: 1;
      }
    >
  >;
}

/** Ask the person, and sign the approval text if they say yes: the keyring's challenge with
 *  what the reviewer says the push sends (shared/approval.ts, signedFor). Everything shown is
 *  read out of the very text that gets signed. A push that replaces the remote's branch is
 *  confirmed by typing `replace <branch>`, not the branch alone. Refuses (exit 78) on
 *  anything else. */
export const sign = async (
  message: string,
  summary?: string[],
  replaces = false,
  size?: number,
): Promise<string> => {
  const push = parseSigned(message);
  const which = kind();
  if (!push)
    throw new Refusal(
      "the root sent something that is not a push approval; nothing was signed",
      "desolate doctor",
      EXIT.unconfirmed,
    );
  if (!which)
    throw new Refusal(
      "this stack has no approver, so no push can be approved",
      "desolate bootstrap",
      EXIT.unconfirmed,
    );
  const shown = [
    "",
    "desolate: this push needs your confirmation.",
    `  repository  ${push.repo}`,
    `  branch      ${push.branch}`,
    `  commit      ${push.commit}`,
    ...(push.squashes
      ? [`  squashes    ${push.squashes}  (its commits, pushed as this one commit)`]
      : []),
    push.onto
      ? `  onto        ${push.onto}  (the remote's ${push.branch} now: it moves from this to the commit, or not at all)`
      : `  onto        none: the remote has no ${push.branch} yet`,
    `  pack        ${push.pack.slice(0, 12)}${size === undefined ? "" : `, ${formatBytes(size)}`}  (made by desolate's reviewer: nothing else is sent)`,
    `  LFS         ${push.lfs.count} object(s), only those its commits point to`,
    ...(replaces
      ? [
          `  REPLACES    the remote's ${push.branch}: it does not build on it, and the commits only the remote has are dropped`,
        ]
      : []),
    ...(summary
      ? [
          // Every line, whole (what is signed can be read: R1), made safe for the terminal,
          // which wraps a long one. A name in another script is shown as itself.
          ...summary.map((line) => `  ${printable(line, Infinity)}`.trimEnd()),
          "              (desolate's reviewer, in the root)",
          // The push again, under what may be a long account: what the answer below is for.
          `  push        ${push.repo} ${push.branch} ${push.commit}${push.squashes ? " (squashed)" : ""}${replaces ? ", replacing the remote's" : ""}`,
        ]
      : []),
    "",
  ];
  const unconfirmed = (why: string, fix: string) =>
    new Refusal(
      `${why}\ndesolate: no person confirmed the push, so nothing was pushed`,
      fix,
      EXIT.unconfirmed,
    );

  const touch = () => {
    process.stderr.write(
      shown.join("\n") +
        "\nConfirm with Touch ID (or your login password) in the dialog macOS is showing.\n",
    );
    const reason = `${replaces ? "REPLACE the remote's" : "approve pushing"} ${push.branch} of ${push.repo} with ${push.commit.slice(0, 12)}${push.squashes ? " (squashed)" : ""}, from ${push.onto ? push.onto.slice(0, 12) : "nothing (a new branch)"}`;
    const signed = spawnSync(FILES.helper, ["sign", FILES.key, reason], {
      input: message,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (signed.status !== 0 || !signed.stdout.trim())
      throw unconfirmed(
        `the Touch ID prompt was not confirmed${signed.stderr ? ` (${signed.stderr.trim()})` : ""}`,
        "run the push again and confirm it",
      );
    return signed.stdout.trim();
  };
  // With Touch ID, the touch is the confirmation; a replace is typed first all the same.
  if (which === "touchid" && !replaces) return touch();

  // The terminal is this process's CONTROLLING terminal, opened by name: not stdin, which
  // a caller could point anywhere.
  let tty: number;
  try {
    tty = fs.openSync("/dev/tty", "r+");
  } catch {
    throw unconfirmed(
      "a push needs a person's confirmation, and there is no terminal to ask on",
      "run it from a terminal of your own, on the host",
    );
  }
  const wanted = replaces ? `replace ${push.branch}` : push.branch;
  fs.writeSync(
    tty,
    [
      ...shown,
      replaces
        ? `Type '${wanted}' to replace it, or anything else to refuse: `
        : `Type the branch name (${push.branch}) to push, or anything else to refuse: `,
    ].join("\n"),
  );
  const answer = await new Promise<string>((resolve) => {
    let text = "";
    const input = fs.createReadStream("", { fd: tty, autoClose: false });
    input.on("data", (chunk) => {
      text += chunk.toString();
      const end = text.indexOf("\n");
      if (end >= 0) {
        input.destroy();
        resolve(text.slice(0, end).trim());
      }
    });
    input.on("end", () => resolve(text.trim()));
    input.on("error", () => resolve(""));
  });
  if (answer !== wanted)
    throw unconfirmed(
      "not confirmed",
      replaces
        ? `run the push again, and type '${wanted}' when it asks`
        : "run the push again, and type the branch name when it asks",
    );
  if (which === "touchid") return touch();
  return signWith(
    "sha256",
    Buffer.from(message),
    createPrivateKey(fs.readFileSync(FILES.key, "utf8")),
  ).toString("base64");
};

declare namespace sign {
  /** refused before anyone is asked: a text that is not a push, a stack with no approver */
  export type Refuses = Given<
    Invoke<typeof emptyHome>,
    [
      Expect<
        Invoke<typeof refusalOf, [run: typeof sign, args: [message: "approve everything"]]>,
        "=",
        {
          message: "the root sent something that is not a push approval; nothing was signed";
          fix: "desolate doctor";
          code: 78;
        }
      >,
      Expect<
        Invoke<
          typeof refusalOf,
          [
            run: typeof sign,
            args: [
              message: "desolate push approval v3\nrepo: acme/web\nbranch: fix/login\ncommit: 0123456789abcdef0123456789abcdef01234567\nonto: none\nsquashes: none\npack: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\nlfs: 0 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nnonce: 00000000000000000000000000000001\n",
            ],
          ]
        >,
        "=",
        {
          message: "this stack has no approver, so no push can be approved";
          fix: "desolate bootstrap";
          code: 78;
        }
      >,
    ]
  >;
}

/** The approval page's signature (host/approve-web.ts): the person's click on that page, on
 *  this Mac, is the confirmation; the page is what checks it was theirs. With the Touch ID
 *  approver the Secure Enclave asks as well. */
export const signClicked = (message: string): string => {
  const push = parseSigned(message);
  const which = kind();
  if (!push) throw new Error("not a push approval; nothing was signed");
  if (which === "touchid") {
    const signed = spawnSync(
      FILES.helper,
      [
        "sign",
        FILES.key,
        `approve pushing ${push.branch} of ${push.repo} to ${push.commit.slice(0, 12)}, from ${push.onto ? push.onto.slice(0, 12) : "nothing (a new branch)"}`,
      ],
      { input: message, encoding: "utf8", timeout: 120_000 },
    );
    if (signed.status !== 0 || !signed.stdout.trim())
      throw new Error(
        `the Touch ID prompt was not confirmed${signed.stderr ? ` (${signed.stderr.trim()})` : ""}`,
      );
    return signed.stdout.trim();
  }
  if (which !== "terminal") throw new Error("this stack has no approver");
  return signWith(
    "sha256",
    Buffer.from(message),
    createPrivateKey(fs.readFileSync(FILES.key, "utf8")),
  ).toString("base64");
};

declare namespace signClicked {
  type Push =
    "desolate push approval v3\nrepo: acme/web\nbranch: fix/login\ncommit: 0123456789abcdef0123456789abcdef01234567\nonto: none\nsquashes: none\npack: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\nlfs: 0 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nnonce: 00000000000000000000000000000001\n";
  /** the approver's signature over exactly the text the page showed, and no other */
  export type Signs = Given<
    [
      Invoke<typeof emptyHome>,
      Invoke<typeof setEnv, [name: "DESOLATE_APPROVER", value: null]>,
      Invoke<typeof init, [log: typeof collect]>,
    ],
    [
      Expect<
        Invoke<
          typeof keyringTakes,
          [message: Push, signature: Invoke<typeof signClicked, [message: Push]>]
        >,
        "=",
        true
      >,
      Expect<
        Invoke<
          typeof keyringTakes,
          [
            message: "desolate push approval v3\nrepo: acme/web\nbranch: main\ncommit: 0123456789abcdef0123456789abcdef01234567\nonto: none\nsquashes: none\npack: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\nlfs: 0 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nnonce: 00000000000000000000000000000001\n",
            signature: Invoke<typeof signClicked, [message: Push]>,
          ]
        >,
        "=",
        false
      >,
    ]
  >;
  /** nothing that is not a push approval is signed, and nothing at all without an approver */
  export type Refuses = [
    Given<
      [Invoke<typeof emptyHome>, Invoke<typeof init, [log: typeof collect]>],
      Throws<
        Invoke<typeof signClicked, [message: "approve everything"]>,
        "not a push approval; nothing was signed"
      >
    >,
    Given<
      Invoke<typeof emptyHome>,
      Throws<Invoke<typeof signClicked, [message: Push]>, "this stack has no approver">
    >,
  ];
}

/** `desolate approve --selftest`: one signature over a text that approves nothing, checked
 *  against the public key the root was given. Proves the person can approve before the
 *  first real push needs it. */
export const selftest = async (out: (line: string) => void): Promise<number> => {
  // A commit no repository has (every digit 1), on a repository that is not one of yours.
  const message = formatSigned({
    repo: "desolate/selftest",
    branch: "selftest",
    commit: "1".repeat(40),
    onto: null,
    squashes: null,
    pack: "0".repeat(64),
    lfs: { count: 0, digest: "0".repeat(64) },
    nonce: "0".repeat(32),
  });
  const signature = await sign(message, ["sends       nothing: this is the approver's self-test"]);
  const pem = publicKey();
  const ok =
    pem !== null &&
    verify("sha256", Buffer.from(message), createPublicKey(pem), Buffer.from(signature, "base64"));
  out(
    ok
      ? `approver (${kind()}): the signature verifies against ${FILES.pub}`
      : "approver: THE SIGNATURE DID NOT VERIFY against the recorded public key",
  );
  return ok ? 0 : 1;
};
