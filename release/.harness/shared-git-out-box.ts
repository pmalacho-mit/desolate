// Harness for in-source tests of the git VM's side of its out-box (git-out-box.ts). It
// stands in for the host: two directories of the test's own in place of /desolate/out and
// /desolate/answers, and the notes and the answer the host would leave in the second.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Boxes, requester as Requester } from "../shared/git-out-box.ts";

let at: Boxes = { out: "", answers: "" };
let heard: string[] = [];
/** How often the stand-in asker looks, and when it says the host has not taken its request. */
const FAST = { pollMs: 5, hintMs: 40 };

/** An empty out-box and an empty answer box. */
export const boxes = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-out-box-"));
  at = { out: path.join(dir, "out"), answers: path.join(dir, "answers") };
  for (const box of [at.out, at.answers]) fs.mkdirSync(box);
  heard = [];
};

/** A push's request as the helper writes it, adding `lfs` LFS objects: its JSON text. */
export const requestOf = (lfs: number): string =>
  JSON.stringify({
    repo: "acme/app",
    branch: "fix",
    commit: "0123456789abcdef0123456789abcdef01234567",
    forced: false,
    lfs: Array.from({ length: lfs }, (_, i) => i.toString(16).padStart(64, "0")),
  });

/** The host has already said these notes and left this answer for request `id`. */
export const answering = (id: string, notes: string[], answer: Record<string, unknown>) => {
  fs.writeFileSync(path.join(at.answers, `${id}.notes`), notes.map((n) => `${n}\n`).join(""));
  fs.writeFileSync(path.join(at.answers, `${id}.json`), JSON.stringify(answer));
};

/** Ask `request` as `id`: the host's answer, and what the asker was told on the way. */
export const hostNotes = async (
  id: string,
  request: Record<string, unknown>,
  requester: typeof Requester,
) => {
  const answer = await requester(at, FAST).ask(id, request, (line) => heard.push(line));
  return { answer, said: [...heard] };
};
/** Everything the asker has been told so far. */
export const said = () => [...heard];

/** Ask a fetch as `id` of a host that says nothing for `forMs`, then answers. */
export const hostSilent = async (id: string, forMs: number, requester: typeof Requester) => {
  setTimeout(
    () => fs.writeFileSync(path.join(at.answers, `${id}.json`), '{"fetched":true}'),
    forMs,
  );
  return hostNotes(id, { op: "fetch", repo: "acme/app" }, requester);
};

/** A push that left its bundle, then asks a request adding `lfs` LFS objects: how it was
 *  refused, and what is still in the out-box. */
export const leftInOut = async (id: string, lfs: number, requester: typeof Requester) => {
  const box = requester(at, FAST);
  fs.writeFileSync(box.leave(`${id}.bundle`), "a bundle");
  let refused = "";
  try {
    await box.ask(id, JSON.parse(requestOf(lfs)) as Record<string, unknown>, () => {});
  } catch (error) {
    refused = (error as Error).message;
  }
  return { refused, left: fs.readdirSync(at.out).sort() };
};
