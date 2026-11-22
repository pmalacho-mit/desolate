// The git VM's out-box: how a program in the git VM asks the host for something (a push:
// git/git-remote-desolate-out.ts; a fetch: git/desolate.ts), and what the two sides say to each other
// while it is done. Both sides read this file (host/git-vm.ts is the other), so each name
// and each bound of the exchange is written once.
//
//   /desolate/out       (the git VM writes; the host reads, and removes what it took)
//     <id>.json           the request, written last and whole (a rename)
//     <id>.bundle         a push's commits      <id>.<oid>.lfs   each LFS object it adds
//     <id>.gone           whoever asked went away (Ctrl-C, a closed terminal): the host stops
//
//   /desolate/answers   (the host writes; read-only in the git VM)
//     <id>.notes          what the host is doing, a line at a time, while it does it
//     <id>.json           the one answer
//
// Nobody here counts minutes. Whoever asked waits for as long as they care to (docs/v3/
// limits.md, R4): the request is the person's at a terminal, and Ctrl-C withdraws it. The
// host answers every request it will not take, at once, with the bound that refused it.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { NAMES, over } from "./limits.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type {
  answering,
  boxes,
  hostNotes,
  hostSilent,
  leftInOut,
  requestOf,
  said,
} from "../.harness/shared-git-out-box.ts";

/** Where the two boxes are, as the git VM sees them (the host's own paths are in host/paths.ts). */
export type Boxes = { out: string; answers: string };
export const GIT_VM_BOXES: Boxes = { out: "/desolate/out", answers: "/desolate/answers" };

/** The most a request may be, in bytes. The host reads it whole, from a file a VM wrote, and
 *  hands what it names to the root over the root's CLI channel, which takes 1 MiB a request
 *  (root/rootctl.ts) and is the size the pusher takes of its own header: 4 KiB under that,
 *  for what the host adds (the operation's name, the bundle's). This is what bounds the LFS
 *  objects one push may add (about 15,000: each is named by 64 characters): there is no
 *  count of them beside it. */
export const REQUEST_BYTES = 1024 * 1024 - 4 * 1024;

/** The files of request `id`, by name: one place for both sides. */
export const named = (id: string) => ({
  request: `${id}.json`,
  bundle: `${id}.bundle`,
  lfs: (oid: string) => `${id}.${oid}.lfs`,
  gone: `${id}.gone`,
  notes: `${id}.notes`,
  answer: `${id}.json`,
});

/** A request's own name: 16 hex characters, which is all the host takes for one. */
export const newId = () => randomBytes(8).toString("hex");
export const isId = (value: string) => /^[0-9a-f]{16}$/.test(value);

/** Why a request's text is not one the host takes (its size, the one bound it has), or null.
 *  The push helper asks before it bundles anything; the host asks again of what it reads. */
export const requestRefusal = (text: string): string | null => {
  const bytes = Buffer.byteLength(text);
  return bytes > REQUEST_BYTES
    ? over("the request", REQUEST_BYTES, bytes, "bytes", "the host takes of one")
    : null;
};

declare namespace requestRefusal {
  /** a push that adds 1,500 LFS objects is about 100 KiB: taken. (The bound before this one
   *  was 64 KiB, which a push of more than about 970 objects passed, and was dropped unread.) */
  export type FifteenHundredObjects = [
    Expect<Invoke<typeof requestRefusal, [text: Invoke<typeof requestOf, [lfs: 1500]>]>, "=", null>,
    /** the control: that request is over the old bound */
    Expect<Invoke<typeof requestOf, [lfs: 1500]>, "matches", "^.{65537,}$">,
  ];
  /** past the bound, the refusal names it and the size that met it */
  export type Over = Expect<
    Invoke<typeof requestRefusal, [text: Invoke<typeof requestOf, [lfs: 20000]>]>,
    "=",
    "the request is 1.3 MiB, over the 1020 KiB the host takes of one"
  >;
}

/** A ref the person names to a command the host runs in the git VM (`desolate upstream
 *  --from`): a branch, a domain's branch, a commit. Both sides check it, the host before it
 *  hands it over and the git VM's command when it reads it, so the rule is here once. Never an
 *  option, never a range or a reflog's `@{`, and no longer than a branch desolate carries. */
export const isRef = (ref: string) =>
  new RegExp(`^[A-Za-z0-9_][A-Za-z0-9._/-]{0,${NAMES.branch - 1}}$`).test(ref) &&
  !ref.includes("..") &&
  !ref.includes("@{");

declare namespace isRef {
  export type Refs = Table<
    typeof isRef,
    [
      [args: [ref: "dev/up/one"], expected: true],
      [args: [ref: "0123456789abcdef0123456789abcdef01234567"], expected: true],
      [args: [ref: "--upload-pack=x"], expected: false],
      [args: [ref: "main..evil"], expected: false],
      [args: [ref: "main@{1}"], expected: false],
      [args: [ref: ""], expected: false],
    ]
  >;
}

/** How often the answer is looked for (the share gives a VM no file events for what the host
 *  writes), and when a request the host has not taken yet is said to be waiting. Neither
 *  ends anything. */
const PACE = { pollMs: 250, hintMs: 5000 };

/** One program's use of the out-box: the files it leaves there, the request it asks, and its
 *  withdrawal when the program is stopped (Ctrl-C, a closed terminal, the VM going down). */
export const requester = (at: Boxes = GIT_VM_BOXES, pace: typeof PACE = PACE) => {
  /** What this program left in the out-box and the host has not answered for: names. */
  const mine = new Set<string>();
  /** The request the host may have taken: it is told when its asker goes. */
  let asked: string | null = null;
  const withdraw = () => {
    // The host is told first, so it stops before it finds a file of this request missing.
    if (asked !== null) {
      try {
        fs.writeFileSync(path.join(at.out, named(asked).gone), "");
      } catch {
        /* the out-box is gone too: nobody to tell */
      }
      asked = null;
    }
    for (const name of mine) fs.rmSync(path.join(at.out, name), { force: true });
    mine.clear();
  };
  // `on`, not `once`: Ctrl-C reaches a push's helper twice (the terminal's SIGINT, and git's,
  // passed on to the helper it runs), and with no listener left the second killed it before
  // it had told the host: the push stayed on the approval page (dogfooding, 2026-11-21).
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    withdraw();
    process.exit(code);
  };
  process.on("SIGINT", () => stop(130));
  process.on("SIGTERM", () => stop(143));
  process.on("SIGHUP", () => stop(129));

  return {
    /** Whoever asked has gone without a signal (git, killed alone, closed this program's
     *  input): what is being asked is withdrawn, and the program ends. Nothing when nothing
     *  is asked: git closes the input after every push, and that one is answered. */
    left: () => {
      if (asked !== null) stop(1);
    },
    /** The path for a file of this program's in the out-box (`name` from `named`): removed
     *  again if the program stops before the host has answered. */
    leave: (name: string) => {
      mine.add(name);
      return path.join(at.out, name);
    },
    /** Take back what was left, for a request that will not be asked after all. */
    withdraw,
    /** Ask, and wait for the host's answer for as long as this program runs: what the host
     *  says meanwhile goes to `say`, a line at a time. Throws the bound's sentence for a
     *  request the host would not take (nothing is written then). */
    ask: async (
      id: string,
      request: Record<string, unknown>,
      say: (line: string) => void,
    ): Promise<Record<string, unknown>> => {
      const text = JSON.stringify(request);
      const refused = requestRefusal(text);
      if (refused) {
        withdraw();
        throw new Error(refused);
      }
      const file = path.join(at.out, named(id).request);
      mine.add(named(id).request);
      fs.writeFileSync(`${file}.part`, text);
      fs.renameSync(`${file}.part`, file);
      asked = id;
      const answer = path.join(at.answers, named(id).answer);
      const notes = path.join(at.answers, named(id).notes);
      let shown = 0;
      let hinted = false;
      for (const since = Date.now(); ; await new Promise((r) => setTimeout(r, pace.pollMs))) {
        // The answer first: the notes that came with it are read below, in the same pass.
        const answered = fs.existsSync(answer);
        let noted = "";
        try {
          noted = fs.readFileSync(notes, "utf8");
        } catch {
          /* none yet */
        }
        const whole = noted.slice(0, noted.lastIndexOf("\n") + 1);
        for (const line of whole.slice(shown).split("\n").slice(0, -1)) say(line);
        shown = whole.length;
        if (answered) {
          // Answered: what is left in the out-box is the host's to remove, and nobody went.
          mine.clear();
          asked = null;
          return JSON.parse(fs.readFileSync(answer, "utf8")) as Record<string, unknown>;
        }
        if (!hinted && shown === 0 && Date.now() - since >= pace.hintMs) {
          hinted = true;
          say(
            "desolate: the host has not taken this yet. It takes one request from this VM at a time (a push waiting for your approval is one); if it is not running, on the Mac: desolate doctor. Still waiting: Ctrl-C stops.",
          );
        }
      }
    },
  };
};

declare namespace requester {
  type Id = "0123456789abcdef";
  /** the host's answer, and what it said on the way, a line at a time and each line once */
  export type Answered = Given<
    [
      Invoke<typeof boxes>,
      Invoke<
        typeof answering,
        [
          id: Id,
          notes: ["desolate: handed to the root.", "  acme/app  fix"],
          answer: { pushed: true },
        ]
      >,
    ],
    [
      Expect<
        Invoke<
          typeof hostNotes,
          [id: Id, request: { repo: "acme/app"; branch: "fix" }, requester: typeof requester]
        >,
        "=",
        { answer: { pushed: true }; said: ["desolate: handed to the root.", "  acme/app  fix"] }
      >,
      Expect<Invoke<typeof said>, "=", ["desolate: handed to the root.", "  acme/app  fix"]>,
    ]
  >;
  /** a host that has not taken it is said, once, and waited for: nothing here gives up */
  export type NotTakenYet = Given<
    Invoke<typeof boxes>,
    Expect<
      Invoke<typeof hostSilent, [id: Id, forMs: 120, requester: typeof requester]>,
      "matches",
      {
        answer: { fetched: true };
        said: [
          "desolate: the host has not taken this yet. It takes one request from this VM at a time (a push waiting for your approval is one); if it is not running, on the Mac: desolate doctor. Still waiting: Ctrl-C stops.",
        ];
      }
    >
  >;
  /** a request over the bound is refused here, with nothing left in the out-box: the files a
   *  push had left for it are taken back */
  export type RefusedBeforeItIsAsked = Given<
    Invoke<typeof boxes>,
    Expect<
      Invoke<typeof leftInOut, [id: Id, lfs: 20000, requester: typeof requester]>,
      "=",
      { refused: "the request is 1.3 MiB, over the 1020 KiB the host takes of one"; left: [] }
    >
  >;
}
