// `desolate status` and `desolate board`: how each checkout says its work is going
// (section 5.1). The status is a small JSON file in the domain clone's git directory, written
// from inside a workspace by /desolate/status. The host reads those files as data and never
// runs git there (P4). What they say is shown, never acted on.
import { EXIT, refuse } from "../shared/exit.ts";
import type { WorkspacePlan } from "../shared/plan.ts";
import { statusView } from "../shared/status.ts";
import type { StatusView as View } from "../shared/status.ts";
import { paths } from "./paths.ts";
import { rootctl } from "./stack.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Call, Expect, Given, Invoke, Mock, Mocked } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { checkoutSays, rootRecord, statusSays } from "../.harness/host-status.ts";
import type { emptyHome } from "../.harness/home.ts";

type Out = (line: string) => void;
const viewOf = (w: WorkspacePlan): View => statusView(paths.domainRepos(w.domain), w);

export const status = async (target: string | undefined, out: Out, json: boolean) => {
  const [domain, workspace] = (target ?? "").split("/");
  if (!domain) refuse("status of what?", "desolate status <domain>[/<workspace>] [--json]", EXIT.usage);
  const d = await rootctl<{ workspaces: WorkspacePlan[] }>("domain.show", { slug: domain }, { quiet: true });
  // The root's records, checked: the domain it names is where status files are read on the
  // Mac (third review: a path the root chose).
  const { isOwnVm } = await import("./workspaces.ts");
  const views = d.workspaces.filter((w) => (!workspace || w.workspace === workspace) && w.domain === domain && isOwnVm(domain, w)).map(viewOf);
  if (workspace && views.length === 0) refuse(`there is no workspace '${target}'`, `desolate list ${domain}`);
  if (json) return out(JSON.stringify(workspace ? views[0] : views));
  for (const view of views) {
    out(`${view.workspace}  ${view.status ? `[${view.status.color}] ${view.status.message}` : "(no status)"}`);
    for (const c of view.checkouts) {
      out(`  ${c.repo}@${c.branch}  ${c.status ? `[${c.status.color}] ${c.status.message}  (${c.status.updated})` : "(no status)"}`);
      if (c.note) for (const line of c.note.split("\n")) out(`    | ${line}`);
    }
  }
};

declare namespace status {
  type Dev = { workspaces: [Invoke<typeof rootRecord, [domain: "dev", workspace: "w1", repo: "acme/widgets", branch: "main"]>, Invoke<typeof rootRecord, [domain: "dev", workspace: "w2", repo: "acme/widgets", branch: "w2"]>] };
  /** each workspace, then each checkout: its status, when it was set, and its note */
  export type Board = Given<
    [
      Invoke<typeof emptyHome>,
      Mock<"./stack.ts">,
      Call<Mocked<typeof rootctl>, "mockResolvedValue", [value: Dev]>,
      Invoke<typeof checkoutSays, [domain: "dev", repo: "acme/widgets", branch: "main", statusJson: '{"color":"blue","message":"working: issue #42","updated":"2026-11-16T10:00:00Z"}', note: "changed the parser\nnext: its tests\n"]>,
    ],
    Expect<Invoke<typeof statusSays, [command: typeof status, target: "dev", json: false]>, "=", { lines: [
      "dev/w1  [blue] working: issue #42",
      "  acme/widgets@main  [blue] working: issue #42  (2026-11-16T10:00:00Z)",
      "    | changed the parser",
      "    | next: its tests",
      "dev/w2  (no status)",
      "  acme/widgets@w2  (no status)",
    ] }>
  >;
  /** what the workspace wrote is shown as text: a terminal sequence in it is made harmless */
  export type AsText = Given<
    [
      Invoke<typeof emptyHome>,
      Mock<"./stack.ts">,
      Call<Mocked<typeof rootctl>, "mockResolvedValue", [value: Dev]>,
      Invoke<typeof checkoutSays, [domain: "dev", repo: "acme/widgets", branch: "w2", statusJson: '{"color":"green","message":"done\\u001b]0;pwned\\u0007","updated":"2026-11-16T10:00:00Z"}', note: ""]>,
    ],
    Expect<Invoke<typeof statusSays, [command: typeof status, target: "dev/w2", json: false]>, "=", { lines: ["dev/w2  [green] done ]0;pwned ", "  acme/widgets@w2  [green] done ]0;pwned   (2026-11-16T10:00:00Z)"] }>
  >;
  /** one workspace, as JSON, is that workspace's view, not a list */
  export type Json = Given<
    [Invoke<typeof emptyHome>, Mock<"./stack.ts">, Call<Mocked<typeof rootctl>, "mockResolvedValue", [value: Dev]>],
    Expect<Invoke<typeof statusSays, [command: typeof status, target: "dev/w2", json: true]>, "=", { lines: ['{"workspace":"dev/w2","checkouts":[{"repo":"acme/widgets","branch":"w2","head":null,"status":null,"note":""}],"status":null}'] }>
  >;
  /** the root's records, checked: one naming another domain, or another domain's VM, is
   *  not read (its status files would be read where the root chose), beside one that is */
  export type ForeignRecords = Given<
    [
      Invoke<typeof emptyHome>,
      Mock<"./stack.ts">,
      Call<Mocked<typeof rootctl>, "mockResolvedValue", [value: { workspaces: [
        Invoke<typeof rootRecord, [domain: "other", workspace: "w1", repo: "acme/widgets", branch: "main"]>,
        Invoke<typeof rootRecord, [domain: "dev", workspace: "w2", repo: "acme/widgets", branch: "w2", vmOf: "other"]>,
        Invoke<typeof rootRecord, [domain: "dev", workspace: "w3", repo: "acme/widgets", branch: "w3"]>,
      ] }]>,
    ],
    Expect<Invoke<typeof statusSays, [command: typeof status, target: "dev", json: false]>, "=", { lines: ["dev/w3  (no status)", "  acme/widgets@w3  (no status)"] }>
  >;
  /** a workspace the root does not record for the domain is refused, with where to look */
  export type NoSuchWorkspace = Given<
    [Invoke<typeof emptyHome>, Mock<"./stack.ts">, Call<Mocked<typeof rootctl>, "mockResolvedValue", [value: Dev]>],
    Expect<Invoke<typeof statusSays, [command: typeof status, target: "dev/w9", json: false]>, "=", { refused: "there is no workspace 'dev/w9'"; fix: "desolate list dev" }>
  >;
  /** no target: refused before the root is asked anything */
  export type NoTarget = Expect<Invoke<typeof statusSays, [command: typeof status, target: undefined, json: false]>, "=", { refused: "status of what?"; fix: "desolate status <domain>[/<workspace>] [--json]" }>;
}
