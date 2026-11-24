// A domain's template (move-to-vms.md section 4.7, C3): its environment built once, and every
// later workspace of the domain a copy-on-write clone of that disk instead of desolate's base.
//
// WHAT IT IS. A stopped VM whose disk has the domain's devcontainer images built (the spec's
// image pulled, its Dockerfile and features built) and its editor's extensions installed.
// A new workspace boots a clone of it; `devcontainer up` there finds the images and makes
// the workspace's own container from them in a second (measured in Phase 0: 11.0 s from
// clone to a running devcontainer, against minutes to build).
//
// WHO MAKES IT, AND WHY THAT IS SAFE. The template is the domain's code's output, so it is
// the domain's and nobody else's: it is built in a VM exactly like the domain's workspaces
// (no network but its own proxy, the domain's shares only, the domain's rules and secrets),
// by the domain's own spec, and only that domain's workspaces are ever cloned from it.
// Nothing of it reaches the root, the host or another domain (the rule in section 4.7: a
// cache a domain writes is shared within that domain only). A template is no more trusted
// than a workspace of its domain, and is given to nothing that trusts it more.
//
// WHAT IS KEYED. The spec as the remote published it (the root's git names it by the id of
// `.devcontainer/` or `.devcontainer.json` on the environment repository's default branch,
// in the mirror) and what made the VM it was built in (the image's provisioning, its pins,
// the code that runs the devcontainer). Any change, and the next `up` builds a new one. A
// workspace whose own checkout has another spec gets that spec built in its clone: right,
// just not faster.
//
// WHAT IS NOT CARRIED. Whatever is one workspace's: its editor's connection token (each
// clone makes its own, so no two editors share one), who it is, its logs, its containers.
import { printableLines } from "../shared/text.ts";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspacePlan } from "../shared/plan.ts";
import type { Size } from "../shared/size.ts";
import { because } from "./failures.ts";
import { imageFingerprint } from "./image.ts";
import { INSTANCE, RELEASE_DIR } from "./paths.ts";
import { backend, rootctl } from "./stack.ts";
import type { VmSpec } from "./vm/types.ts";
import type { Expect, Given, Invoke, Mock } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { collect, fakeStack, noBuilder, rootAnswers, said } from "../.harness/host-stack.ts";

type EnvKey = { repo: string; spec: string; id: string };
export type Builder = {
  specOf: (plan: WorkspacePlan, repos: string[]) => VmSpec;
  startServices: (
    plan: WorkspacePlan,
  ) => Promise<{ devcontainer: string; editorDown: string | null }>;
};

const hashOf = (...parts: string[]) => createHash("sha256").update(parts.join("\n")).digest("hex");
const released = (file: string) => {
  try {
    return hashOf(fs.readFileSync(path.join(RELEASE_DIR, file), "utf8"));
  } catch {
    return "missing";
  }
};
/** The template's key: the spec, and what the VM it is built in is made of. */
export const keyOf = (env: EnvKey) =>
  hashOf(
    env.repo,
    env.spec,
    env.id,
    imageFingerprint(),
    released("workspace/devcontainer.ts"),
    released("workspace/editor.sh"),
  ).slice(0, 16);
/** `dsl-<instance>-t<9 hex>`: as long as a workspace's VM name (the socket-path check counts
 *  on it), and never one ("t" is not hex). */
export const templateVm = (domain: string, key: string) =>
  `dsl-${INSTANCE}-t${hashOf(domain, key).slice(0, 9)}`;

declare namespace keyOf {
  type Env = {
    repo: "acme/web";
    spec: ".devcontainer";
    id: "0123456789abcdef0123456789abcdef01234567";
  };
  /** sixteen hex digits, the same for the same environment, another for any change to its spec */
  export type Keys = [
    Expect<Invoke<typeof keyOf, [env: Env]>, "matches", "^[0-9a-f]{16}$">,
    Expect<Invoke<typeof keyOf, [env: Env]>, "=", Invoke<typeof keyOf, [env: Env]>>,
    Expect<
      Invoke<typeof keyOf, [env: Env]>,
      "!=",
      Invoke<
        typeof keyOf,
        [
          env: {
            repo: "acme/web";
            spec: ".devcontainer";
            id: "1111111111111111111111111111111111111111";
          },
        ]
      >
    >,
  ];
}
declare namespace templateVm {
  /** as long as a workspace's VM name (dsl-<instance>- and ten more), and never one: "t" is
   *  not hex; one domain's template is never another's */
  export type Names = [
    Expect<
      Invoke<typeof templateVm, [domain: "acme", key: "0123456789abcdef"]>,
      "matches",
      "^dsl-main-t[0-9a-f]{9}$"
    >,
    Expect<
      Invoke<typeof templateVm, [domain: "acme", key: "0123456789abcdef"]>,
      "!=",
      Invoke<typeof templateVm, [domain: "beta", key: "0123456789abcdef"]>
    >,
  ];
}

/** Run as root in the template before it is stopped: what is one workspace's goes. */
const SCRUB = `set -e
docker ps -aq 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
for home in /home/*; do
  rm -f "$home/.desolate-editor/token" "$home/.desolate-editor/token.epoch" "$home/.desolate-editor/gate.host" "$home/.desolate-editor/gate.pid" "$home/.desolate-editor/server.pid" "$home/.desolate/workspace.json"
done
rm -f /var/lib/desolate/*.log
sync`;

/** Run in the builder, as the user its checkouts are made as, with a worktree's clone, path,
 *  branch and base: the worktree and its branch go when they hold nothing (the branch's every
 *  commit is the base's, the worktree has no change but what is ignored, the build's own
 *  output). A domain whose main checkout another workspace holds gives the build a worktree
 *  named for it, and its `template` branch stayed in the domain's Branches, made by nobody
 *  (dogfooding, 2026-11-21). Anything of a person's there is kept. */
export const UNBRANCH = `cd "$1" || exit 0
git rev-parse --verify --quiet "refs/heads/$3" >/dev/null || exit 0
git merge-base --is-ancestor "refs/heads/$3" "$4" 2>/dev/null || git merge-base --is-ancestor "refs/heads/$3" "origin/$4" 2>/dev/null || exit 0
if [ -e "$2/.git" ]; then
  [ -z "$(git -C "$2" status --porcelain)" ] || exit 0
  git worktree unlock "$2" 2>/dev/null
  git worktree remove --force "$2" || exit 1
fi
git branch -D "$3" >/dev/null`;

/** The domain's template for its environment as published now: present, or built now.
 *  null when the domain has no spec, or the build did not come up (the workspace is then made
 *  from desolate's base, as before, and `say` says why). */
export const ensure = async (
  domain: string,
  repos: string[],
  build: Builder,
  say: (line: string) => void,
  envRepo?: string,
  size?: Size,
): Promise<string | null> => {
  // A template only makes a start faster: nothing about one may stop a workspace being made
  // (two `up`s at once in a domain: the second finds the first's build under way).
  try {
    return await ensureOrThrow(domain, repos, build, say, envRepo, size);
  } catch (error) {
    say(
      `  no template: ${printableLines((error as Error).message)}. This workspace is made from desolate's base.`,
    );
    return null;
  }
};

declare namespace ensure {
  /** a domain with no devcontainer spec has no template, and nothing is said */
  export type NoSpec = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<typeof rootAnswers, [answers: { "domain.env-key": null }]>,
    ],
    [
      Expect<
        Invoke<
          typeof ensure,
          [domain: "acme", repos: ["acme/web"], build: typeof noBuilder, say: typeof collect]
        >,
        "=",
        null
      >,
      Expect<Invoke<typeof said>, "=", []>,
    ]
  >;
  /** anything that goes wrong only makes the start slower: the workspace is made from the base,
   *  and the person is told why */
  export type NeverStopsAWorkspace = Given<
    [Mock<"./stack.ts", typeof fakeStack>, Invoke<typeof rootAnswers, [answers: {}]>],
    [
      Expect<
        Invoke<
          typeof ensure,
          [domain: "acme", repos: ["acme/web"], build: typeof noBuilder, say: typeof collect]
        >,
        "=",
        null
      >,
      Expect<
        Invoke<typeof said>,
        "=",
        [
          "  no template: the root did not answer 'domain.env-key'. This workspace is made from desolate's base.",
        ]
      >,
    ]
  >;
}

const ensureOrThrow = async (
  domain: string,
  repos: string[],
  build: Builder,
  say: (line: string) => void,
  envRepo?: string,
  size?: Size,
): Promise<string | null> => {
  const b = backend();
  const env = await rootctl(
    "domain.env-key",
    { slug: domain, ...(envRepo ? { repo: envRepo } : {}) },
    { quiet: true },
  );
  if (!env) return null;
  const key = keyOf(env);
  const name = templateVm(domain, key);
  const info = await b.info(name);
  if (info.status === "stopped" && info.labels.template === key && info.labels.domain === domain)
    return name;
  // A template of this domain for this environment, made from an older spec, is stale; one
  // half made is no use. Another environment's is not: a domain with a python repository and a
  // node one keeps a template for each (one made before templates were labelled with their
  // environment counts as stale).
  for (const vm of await b.list())
    if (
      vm.labels.domain === domain &&
      vm.labels.template &&
      vm.name !== name &&
      (vm.labels.env ?? env.repo) === env.repo
    )
      await b.destroy(vm.name);
  if (info.status !== "missing") await b.destroy(name);

  say(
    `  building ${domain}'s environment once (${env.repo}, ${env.spec} ${env.id.slice(0, 12)}): later workspaces start from it`,
  );
  const plan = await rootctl(
    "workspace.plan",
    {
      instance: INSTANCE,
      domain,
      name: "template",
      checkouts: [],
      base: null,
      fetch: false,
      env: env.repo,
      // Built at the size its workspaces get (but for `up`'s flags): a project that needs
      // 16 GiB to install needs it while its environment is built, too.
      ...(size ? { size } : {}),
    },
    { quiet: true },
  );
  const builder: WorkspacePlan = { ...plan, vm: name };
  const spec: VmSpec = {
    ...build.specOf(builder, repos),
    labels: { title: `${domain} template`, domain, template: key, env: env.repo },
  };
  const { disconnectWorkspace } = await import("./daemon.ts");
  let made = false;
  // A line per phase, with its time: a first `up` sat on the line above for 200 s on the M1,
  // and looked hung (dogfooding).
  const began = Date.now();
  const took = () => `${Math.round((Date.now() - began) / 1000)} s`;
  try {
    await b.create(spec);
    await b.start(name);
    say(
      `  its VM is up (${took()}); now the project's devcontainer: its image, features and setup commands, usually the longest part`,
    );
    const { devcontainer } = await build.startServices(builder);
    if (!devcontainer.startsWith("up"))
      throw new Error(`its devcontainer did not come up: ${devcontainer}`);
    say(`  devcontainer up (${took()}); keeping it as ${domain}'s template`);
    const scrubbed = await b.exec(name, ["bash", "-c", SCRUB], { root: true, timeoutMs: 120_000 });
    if (scrubbed.code !== 0)
      throw new Error(
        because(
          "it could not be emptied of what was the builder's",
          "template-scrub",
          scrubbed.stderr,
        ),
      );
    made = true;
  } catch (error) {
    say(
      `  no template: ${printableLines((error as Error).message)}. This workspace is made from desolate's base.`,
    );
  } finally {
    const up = (await b.info(name).catch(() => null))?.status === "running";
    for (const c of up ? builder.checkouts.filter((c) => c.kind === "worktree") : []) {
      const argv = [`/workspaces/${c.repo}`, c.path, c.branch, c.base];
      const gone = await b
        .exec(name, ["sh", "-c", UNBRANCH, "unbranch", ...argv], { timeoutMs: 120_000 })
        .catch((error: Error) => ({ code: 1, stdout: "", stderr: error.message }));
      if (gone.code !== 0)
        say(`  the build's worktree of ${c.repo} stays: ${printableLines(gone.stderr.trim())}`);
    }
    await disconnectWorkspace(name).catch(() => {});
    await rootctl("proxy.stop", { vm: name }, { quiet: true }).catch(() => {});
    await rootctl("workspace.remove", { domain, name: "template" }, { quiet: true }).catch(
      () => {},
    );
    if (made) await b.stop(name).catch(() => {});
    else await b.destroy(name).catch(() => {});
  }
  return made && (await b.info(name)).status === "stopped" ? name : null;
};

/** Every template a domain has (when the domain is removed). */
export const removeAll = async (domain: string) => {
  const b = backend();
  for (const vm of await b.list())
    if (vm.labels.domain === domain && vm.labels.template) await b.destroy(vm.name);
};
