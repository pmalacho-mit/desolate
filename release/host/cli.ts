// The desolate command, on the host. It drives everything, holds no key, and runs no git on
// desolate's repositories (P4).
import { forTerminal, printable } from "../shared/text.ts";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EXIT, Refusal, refuse } from "../shared/exit.ts";
import { parseRepo } from "../shared/names.ts";
import type { Expect, Invoke, Table, Throws } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { printed } from "../.harness/host-cli.ts";
import type { refusalOf } from "../.harness/refusal.ts";

const HELP = `desolate: develop in VMs of their own. A workspace per task, an editor inside it, every push through you.

Every day: a workspace, your work in it, and its push:
  desolate up <domain> [--name <workspace>] [--branch <branch>] [--fetch] [--base <ref>]
              [--cpus <n>] [--memory <8g>] [--disk <60g>]   (defaults: from this Mac; per domain: domain <d> size)
              [--checkout <owner/repo>=main|worktree:<branch>]   a workspace: one VM, its checkouts
  desolate list [<domain>] [--json]
  desolate editor <domain>/<workspace> [--open] [--json]         the address of its editor, for your browser
  desolate editor defaults [--json] | set <setting> <value> | unset <setting> | replace | reset
                                                                 every editor's default settings (its own, the devcontainer's override them)
  desolate exec <domain>/<workspace> [--checkout <repo>] [--vm] -- <cmd>
                                                                 a command in its devcontainer (bash: a shell there)
                                                                 (or in the VM itself: when it has none, or --vm)
  desolate ports [<domain>/<workspace>] [--json]                 what is forwarded, at which URL; what is reserved
  desolate stop | start | rm <domain>/<workspace>
  desolate resize <domain>/<workspace> [--cpus <n>] [--memory <16g>] [--disk <60g>]
                                                                 a stopped workspace's size (no flags: what it has, and its project asks)
  desolate rm <domain>/<workspace> --if-clean [--if-pushed]      only if nothing in it would be lost (and its commits are on the remote)
  desolate up <domain> ... -- <command...>                       and an agent in it, once it is up
  desolate ui [--open | --link] [--json]                         the dashboard's address; --open signs your browser in to all three pages
  desolate phone [on | off]                                      the dashboard on your phone, over Tailscale
  desolate phone dev <domain> | off                              which one domain's dev servers the phone reaches
  desolate offers [<domain>] [--json]                            what workspaces have offered: needs you
  desolate offers dismiss <domain> <owner/repo> <branch>         not this one: off "Needs you" (the branch stays)
  desolate branches [<domain>] [--json]                          every branch each domain has (offered or not)
  desolate issues [--json]                                       GitHub issues workspaces offered: edit them on the dashboard
  desolate issue publish | refuse <id>                           create one on GitHub, as you, once you have read it (or not)
  desolate review <domain> <owner/repo> <branch> [--diff] [--against origin|domain] [--json]
                                                                 what a push would send; --diff: the diff itself
  desolate push <domain> <owner/repo> <branch> --expect <commit>
                                                                 to the remote; you approve it here, on the
                                                                 host, on your terminal
  desolate approve [--web [--open] | --selftest]                 approve a push waiting for you (the dashboard's, the
                                                                 git terminal's, the root shell's)
                                                                 (--web: the approval page's address, for one click)
  desolate git [<owner/repo>] [--open]                           a shell in the git VM, in your browser: your own
                                                                 clones, git and nothing else; pushes wait for approval
  desolate status | board <domain>[/<workspace>] [--json]        how each checkout says its work is going

Your repositories and domains:
  desolate clone <owner/repo> [--no-push] [--anonymous]          keys, mirror (with LFS), root clone, and a domain
                [--domain <d> | --no-domain]                    named owner--repo (or <d>; or none)
                [--keys-by-hand]                                 print the deploy keys for the repository's admin to add
  desolate fetch <owner/repo>                                    remote -> mirror
  desolate repos [--json]
  desolate keys [<owner/repo>] [--json]                          which keys the root holds; a key's public half
  desolate domain create <slug> [--title "..."] [--repo <owner/repo>]...
                                                                 a trust boundary: repositories and secrets
  desolate domain <slug> add --repo <owner/repo>                 give the domain a repository
  desolate domain <slug> size [--cpus <n>] [--memory <8g>] [--disk <60g>] [--clear]
                                                                 what its new workspaces get (shown: the effective size)
  desolate domain <slug> spawn [--max <n>|none]                  limit the workspaces its workspaces start (none: no limit, the default; 0: off)
  desolate domain <slug> stats [--json]                          its workspaces, who started each, its limit, this Mac
  desolate domain <slug> env [--from <owner/repo>]               whose devcontainer.json its workspaces run
  desolate domain <slug> net [open | enforce | allow <host>... | deny <host>...]
                                                                 the domain's network rules, at its proxies
  desolate net log [<domain>] [--json]                           what each workspace asked to reach, and the verdict
  desolate domain <domain> net recommend                         what it reached that is not on its list
  desolate domain <domain> secret set <NAME> --hosts <h>[,...] [--headers <h>[,...]] | copy <NAME> --from <d> | list | off | on [--ttl 30m] | rm | show
                                                                 a secret: the value on stdin, the name in workspaces
  desolate domain <domain> secret import <.env> [--dry-run] [--print-env | --in-place] [--choose KEY=secret:<host>[@<header>] | KEY=value]
                                                                 a project's .env: its API keys become secrets, and the .env their names
  desolate rm <domain>                                           the domain and its clones; not the root's

Programs kept running in a workspace (a dev server, a watcher, a coding agent):
  desolate agent start <domain>/<workspace> [--name <n>] [--checkout <repo>] -- <command...>
                                                                 any program kept running in a workspace (a dev server,
                                                                 a watcher, a coding agent), with its terminal; no tmux
  desolate agent attach|log|stop <domain>/<workspace> [--name <n>]   your terminal on it; Ctrl-] detaches
  desolate agent list [<domain>[/<workspace>]] [--json]          every one, in every workspace
  desolate agent say <domain>/<workspace> [--name <n>] -- <text>  type a line into it (and Enter), without attaching

Hearing about it, and scripting it:
  desolate notify [--ntfy <https://ntfy.sh/topic>]              notifications on this Mac: a push waiting, an offer,
                                                                 a workspace asking for you, a push done; until stopped
                                                                 (--ntfy: to your phone too; pick a long random topic)
  desolate events [--replay <n>]                                 what happens, as JSON lines, until stopped: pushed,
                                                                 offered, status, approval-waiting, workspace-up, ...

Suede dependencies:
  desolate suede changed <owner/repo> <commit> [--from <commit>] [--json]
                                                                 which vendored suede dependencies a commit changed
  desolate upstream <consumer> <dependency-dir> <owner/repo> [--from <domain>/<branch>] [--no-wait] [--remote <url>]
                                                                 a consumer's change to a vendored suede dependency,
                                                                 proposed to it (suede's upstream, pinned, in the git
                                                                 VM); you approve the push; waits for the pull request

The stack itself:
  desolate bootstrap [--backend vz|qemu|fake] [--forge github]   from nothing to a working stack
  desolate doctor [--json]                                       check it; every failure names its fix
  desolate down                                                  stop every VM and the daemon; remove nothing
  desolate destroy [--all]                                       remove the VMs (--all: and ~/.desolate)
  desolate root shell                                            the root's terminal: git on the root clones
  desolate completion                                            tab completion for zsh and bash (below)
  desolate help                                                  this text

Recipes (scripts of these commands, for tasks you do often: an agent on a task, Claude Code, issues):
  ~/desolate/recipes/README.md. Tab completion names your domains and workspaces: echo 'source <(desolate completion)' >> ~/.zshrc

<command> --help shows that command's lines of this text, and runs nothing.
Every command that reads takes --json. Exit codes: 0 ok, 1 failed, 64 usage, 75 busy,
77 default branch refused, 78 no person confirmed the push, 79 --expect did not match.`;

// Every line the CLI prints passes here: text another wrote (a branch, a path in a commit, a
// VM's error) never reaches the terminal as something it would act on (shared/text.ts).
const out = (line: string) => process.stdout.write(`${forTerminal(line)}\n`);
const err = (line: string) => process.stderr.write(`${forTerminal(line)}\n`);

type Flags = { values: Record<string, unknown>; positionals: string[] };
const flags = (
  argv: string[],
  options: Record<string, { type: "boolean" | "string"; multiple?: boolean }>,
): Flags => {
  try {
    return parseArgs({
      args: argv,
      options: { json: { type: "boolean" }, help: { type: "boolean" }, ...options },
      allowPositionals: true,
      strict: true,
    }) as Flags;
  } catch (error) {
    throw new Refusal((error as Error).message, "desolate help", EXIT.usage);
  }
};

declare namespace flags {
  /** every command takes --json and --help besides its own; the rest are its positionals */
  export type Reads = Expect<
    Invoke<
      typeof flags,
      [
        argv: [
          "acme",
          "--name",
          "w1",
          "--checkout",
          "acme/web=main",
          "--checkout",
          "acme/api=main",
          "--json",
        ],
        options: { name: { type: "string" }; checkout: { type: "string"; multiple: true } },
      ]
    >,
    "=",
    {
      values: { name: "w1"; checkout: ["acme/web=main", "acme/api=main"]; json: true };
      positionals: ["acme"];
    }
  >;
  /** a flag the command does not take is a usage error (exit 64) that points at the help, never
   *  a word passed on; a string flag with no value is not read as a boolean */
  export type Refuses = [
    Expect<
      Invoke<typeof refusalOf, [f: typeof flags, args: [argv: ["acme", "--force"], options: {}]]>,
      "matches",
      { fix: "desolate help"; code: 64 }
    >,
    Throws<
      Invoke<typeof flags, [argv: ["acme", "--force"], options: {}]>,
      "Unknown option '--force'"
    >,
    Throws<
      Invoke<typeof flags, [argv: ["acme", "--name"], options: { name: { type: "string" } }]>,
      "argument missing"
    >,
  ];
}

/** Whether a command line asks for help: `--help` or `-h` anywhere before a `--`. Asked, the
 *  command does not run. (Every verb's flags take `--help`, and none acted on it: `desolate
 *  destroy --help` destroyed the stack.) After `--` the words are another program's, as in
 *  `desolate agent start acme/w1 -- npm --help`. */
const askedForHelp = (argv: string[]): boolean => {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).some(
    (word) => word === "--help" || word === "-h",
  );
};

declare namespace askedForHelp {
  /** before `--` only */
  export type Reads = Table<
    typeof askedForHelp,
    [
      [[argv: ["destroy", "--help"]], true],
      [[argv: ["rm", "acme/w1", "-h"]], true],
      [[argv: ["domain", "acme", "net", "--help", "allow"]], true],
      [[argv: ["agent", "start", "acme/w1", "--name", "web", "--", "npm", "--help"]], false],
      [[argv: ["exec", "acme/w1", "--", "ls", "-h"]], false],
      [[argv: ["list", "--json"]], false],
      [[argv: ["domain", "create", "acme", "--title", "help"]], false],
    ]
  >;
}

/** The help's lines for one verb (each `  desolate <verb> ...` line and the lines that carry it
 *  on), or none: the caller then prints the whole help. */
const helpFor = (help: string, verb: string): string[] => {
  const lines: string[] = [];
  let taking = false;
  for (const line of help.split("\n")) {
    // A line may name several verbs: `  desolate stop | start | rm <domain>/<workspace>`.
    const named = /^  desolate ((?:[\w-]+ \| )*[\w-]+)/.exec(line);
    if (named) taking = named[1]!.split(" | ").includes(verb);
    else if (!/^ {4,}\S/.test(line)) taking = false;
    if (taking) lines.push(line);
  }
  return lines;
};

declare namespace helpFor {
  /** a verb's lines, with their carried-on lines; another verb's are left out */
  export type Picks = Expect<
    Invoke<
      typeof helpFor,
      [
        help: "Workspaces:\n  desolate rm <w>      remove it\n                       its branches stay\n  desolate rmx         another\n  desolate rm --all    all of them\nExit codes: 0 ok",
        verb: "rm",
      ]
    >,
    "=",
    [
      "  desolate rm <w>      remove it",
      "                       its branches stay",
      "  desolate rm --all    all of them",
    ]
  >;
  /** a line that names several verbs is each one's */
  export type Several = Expect<
    Invoke<
      typeof helpFor,
      [help: "  desolate stop | start | rm <w>   one\n  desolate starts   another", verb: "start"]
    >,
    "=",
    ["  desolate stop | start | rm <w>   one"]
  >;
  /** an unknown verb has no lines */
  export type None = Expect<
    Invoke<typeof helpFor, [help: "  desolate rm <w>   remove it", verb: "nope"]>,
    "=",
    []
  >;
}

/** `--open`: the address in a browser on this Mac. Chrome or Firefox if there is one:
 *  Safari cannot find desolate's *.localhost names. */
const openInBrowser = (url: string) => {
  if (process.platform !== "darwin") return void spawnSync("xdg-open", [url], { stdio: "ignore" });
  const browser =
    process.env.DESOLATE_BROWSER ??
    ["Google Chrome", "Firefox", "Chromium", "Brave Browser", "Microsoft Edge"].find((app) =>
      fs.existsSync(`/Applications/${app}.app`),
    );
  const opened = spawnSync("open", browser ? ["-a", browser, url] : [url], { stdio: "ignore" });
  if (opened.status !== 0 || !browser)
    process.stderr.write(
      `desolate: ${browser ? `could not open ${browser}` : "no Chrome or Firefox found: Safari cannot open *.localhost addresses"}; open the address above in Chrome or Firefox\n`,
    );
};

const main = async (argv: string[]): Promise<number> => {
  const [verb, ...rest] = argv;
  if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
    out(HELP);
    return verb ? EXIT.ok : EXIT.usage;
  }
  if (askedForHelp(rest)) {
    const lines = helpFor(HELP, verb);
    for (const line of lines.length ? lines : HELP.split("\n")) out(line);
    return EXIT.ok;
  }
  if (verb === "bootstrap") {
    const { values } = flags(rest, {
      backend: { type: "string" },
      forge: { type: "string" },
      "forge-known-hosts": { type: "string" },
    });
    if (values.backend) process.env.DESOLATE_BACKEND = String(values.backend);
    const { bootstrap } = await import("./bootstrap.ts");
    await bootstrap(
      {
        forge: values.forge as string | undefined,
        forgeKnownHosts: values["forge-known-hosts"] as string | undefined,
      },
      out,
    );
    return EXIT.ok;
  }
  if (verb === "doctor") {
    const { values } = flags(rest, {});
    const { doctor } = await import("./bootstrap.ts");
    return (await doctor(out, values.json === true)) === 0 ? EXIT.ok : EXIT.failed;
  }
  if (verb === "destroy") {
    const { values } = flags(rest, { all: { type: "boolean" } });
    const { destroy } = await import("./bootstrap.ts");
    return (await destroy({ all: values.all === true }, out)).length === 0 ? EXIT.ok : EXIT.failed;
  }
  if (verb === "clone") {
    const { values, positionals } = flags(rest, {
      "no-push": { type: "boolean" },
      anonymous: { type: "boolean" },
      domain: { type: "string" },
      "no-domain": { type: "boolean" },
      "keys-by-hand": { type: "boolean" },
    });
    const { clone } = await import("./repos.ts");
    if (values.domain !== undefined && values["no-domain"] === true)
      refuse("--domain and --no-domain say opposite things", "give one of them", EXIT.usage);
    await clone(
      positionals[0],
      {
        push: values["no-push"] !== true && values.anonymous !== true,
        anonymous: values.anonymous === true,
        domain: values["no-domain"] === true ? false : (values.domain as string | undefined),
        byHand: values["keys-by-hand"] === true,
      },
      out,
      values.json === true,
    );
    return EXIT.ok;
  }
  if (verb === "fetch") {
    const { values, positionals } = flags(rest, {});
    const { fetch } = await import("./repos.ts");
    await fetch(positionals[0], out, values.json === true);
    return EXIT.ok;
  }
  if (verb === "keys") {
    const { values, positionals } = flags(rest, {});
    const { keys } = await import("./repos.ts");
    await keys(positionals[0], out, values.json === true);
    return EXIT.ok;
  }
  if (verb === "repos") {
    const { values } = flags(rest, {});
    const { repos } = await import("./repos.ts");
    await repos(out, values.json === true);
    return EXIT.ok;
  }
  if (verb === "domain") {
    const { values, positionals } = flags(rest, {
      title: { type: "string" },
      repo: { type: "string", multiple: true },
      max: { type: "string" },
      cpus: { type: "string" },
      memory: { type: "string" },
      disk: { type: "string" },
      clear: { type: "boolean" },
      hosts: { type: "string" },
      headers: { type: "string" },
      ttl: { type: "string" },
      secret: { type: "string" },
      from: { type: "string" },
      "dry-run": { type: "boolean" },
      "print-env": { type: "boolean" },
      "in-place": { type: "boolean" },
      choose: { type: "string", multiple: true },
    });
    const { domainCommand } = await import("./domains.ts");
    await domainCommand(positionals, values, out);
    return EXIT.ok;
  }
  if (verb === "net" && rest[0] === "log") {
    const { values, positionals } = flags(rest.slice(1), {});
    const { rootctl } = await import("./stack.ts");
    const entries = await rootctl<
      {
        time: string;
        domain: string;
        workspace: string;
        host: string;
        port: number;
        verdict: string;
        reason?: string;
        secrets?: string[];
      }[]
    >("net.log", { domain: positionals[0] }, { quiet: true });
    if (values.json === true) out(JSON.stringify(entries));
    else
      for (const e of entries)
        out(
          `${e.time}  domain=${e.domain} workspace=${e.workspace}  ${e.verdict}  ${String(e.host).replace(/[^\x21-\x7e]/g, "?")}:${e.port}${Array.isArray(e.secrets) ? `  [${e.secrets.join(", ").replace(/[^\x21-\x7e ]/g, "?")}]` : ""}${e.reason ? `  (${printable(e.reason)})` : ""}`,
        );
    return EXIT.ok;
  }
  if (verb === "up") {
    // `--` ends desolate's own flags: everything after it is an agent's command, started in
    // the workspace once it is up.
    const dash = rest.indexOf("--");
    const own = dash >= 0 ? rest.slice(0, dash) : rest;
    const command = dash >= 0 ? rest.slice(dash + 1) : [];
    const { values, positionals } = flags(own, {
      name: { type: "string" },
      checkout: { type: "string", multiple: true },
      branch: { type: "string" },
      base: { type: "string" },
      fetch: { type: "boolean" },
      cpus: { type: "string" },
      memory: { type: "string" },
      disk: { type: "string" },
      "started-by": { type: "string" },
    });
    const { up, sizeFlags } = await import("./workspaces.ts");
    await up(
      positionals[0],
      {
        name: values.name as string | undefined,
        checkouts: (values.checkout as string[] | undefined) ?? [],
        branch: values.branch as string | undefined,
        base: values.base as string | undefined,
        fetch: values.fetch === true,
        size: sizeFlags(values),
        startedBy: values["started-by"] as string | undefined,
        command,
      },
      out,
      values.json === true,
    );
    return EXIT.ok;
  }
  if ((verb === "status" || verb === "board") && rest.some((arg) => !arg.startsWith("-"))) {
    const { values, positionals } = flags(rest, {});
    const { status } = await import("./status.ts");
    await status(positionals[0], out, values.json === true);
    return EXIT.ok;
  }
  if (verb === "list" || verb === "status" || verb === "board") {
    const { values, positionals } = flags(rest, {});
    const { list } = await import("./workspaces.ts");
    await list(out, values.json === true, positionals[0]);
    return EXIT.ok;
  }
  if (verb === "resize") {
    const { values, positionals } = flags(rest, {
      cpus: { type: "string" },
      memory: { type: "string" },
      disk: { type: "string" },
    });
    const { resize, sizeFlags } = await import("./workspaces.ts");
    await resize(
      positionals[0],
      sizeFlags(values as { cpus?: string; memory?: string; disk?: string }),
      out,
    );
    return EXIT.ok;
  }
  if (verb === "stop" || verb === "start" || verb === "rm") {
    const { values, positionals } = flags(
      rest,
      verb === "rm" ? { "if-clean": { type: "boolean" }, "if-pushed": { type: "boolean" } } : {},
    );
    const workspaces = await import("./workspaces.ts");
    if (verb === "rm")
      await workspaces.remove(positionals[0], out, {
        ifClean: values["if-clean"] === true,
        ifPushed: values["if-pushed"] === true,
      });
    else await (verb === "stop" ? workspaces.stop : workspaces.start)(positionals[0], out);
    return EXIT.ok;
  }
  if (verb === "offers") {
    const { values, positionals } = flags(rest, {});
    if (positionals[0] === "dismiss") {
      const [, domain, repo, branch] = positionals;
      if (!domain || !repo || !branch)
        refuse(
          "dismiss which offer?",
          "desolate offers dismiss <domain> <owner/repo> <branch>   (see desolate offers)",
          EXIT.usage,
        );
      const { rootctl } = await import("./stack.ts");
      await rootctl("offers.dismiss", { domain, repo, branch }, { quiet: true });
      out(
        `dismissed: ${domain} ${repo} ${branch} is no longer under "Needs you". The branch stays (desolate branches ${domain}); offering it again brings it back.`,
      );
      return EXIT.ok;
    }
    const { offers } = await import("./push.ts");
    await offers(positionals[0], out, values.json === true);
    return EXIT.ok;
  }
  if (verb === "branches") {
    const { values, positionals } = flags(rest, {});
    const { branches } = await import("./push.ts");
    await branches(positionals[0], out, values.json === true);
    return EXIT.ok;
  }
  if (verb === "review") {
    const { values, positionals } = flags(rest, {
      diff: { type: "boolean" },
      against: { type: "string" },
    });
    if (values.against !== undefined && values.against !== "origin" && values.against !== "domain")
      refuse(
        `--against '${String(values.against)}' is not understood`,
        "--against origin (the remote's default branch, as the mirror has it) or --against domain (the domain's own copy of it)",
        EXIT.usage,
      );
    const { review } = await import("./push.ts");
    await review(
      values.diff === true ? [...positionals, "--diff"] : positionals,
      out,
      values.json === true,
      values.against === "domain" ? "domain" : "origin",
    );
    return EXIT.ok;
  }
  if (verb === "push") {
    flags(rest, { expect: { type: "string" }, "allow-default": { type: "boolean" } });
    const { push } = await import("./push.ts");
    return push(rest);
  }
  if (verb === "ui") {
    const { values } = flags(rest, { open: { type: "boolean" }, link: { type: "boolean" } });
    const { ui, signinAddress } = await import("./daemon.ts");
    // One link for all three pages (signin.ts), each signed in until the browser quits: opened
    // (--open), or printed for a browser of your choosing (--link). Good once, for a minute.
    if (values.link === true) {
      out(await signinAddress());
      return EXIT.ok;
    }
    const shown = await ui();
    if (values.json === true) out(JSON.stringify(shown));
    else out(`dashboard    ${shown.dashboard}\napprovals    ${shown.approvals}`);
    if (values.open === true) openInBrowser(await signinAddress());
    return EXIT.ok;
  }
  if (verb === "phone") {
    const { positionals } = flags(rest, {});
    const what = positionals[0] ?? "status";
    const phone = await import("./phone.ts");
    // Serve is pointed only at ports this daemon holds: a port another program holds would be
    // sent the phone's requests, the tokens in their cookies.
    const ready = async () => {
      const { phoneReady } = await import("./daemon.ts");
      const missing = await phoneReady();
      if (missing.length)
        refuse(
          `another program holds what the phone would be sent to (${missing.slice(0, 3).join(", ")})`,
          "find it (lsof -nP -iTCP -sTCP:LISTEN), stop it, then: desolate bootstrap",
        );
    };
    if (what === "on") {
      await ready();
      const on = await phone.phoneOn();
      if ("refused" in on) refuse(on.refused, on.fix);
      const { ui } = await import("./daemon.ts");
      const token = new URL((await ui()).dashboard).searchParams.get("tkn") ?? "";
      const { agentsToken } = await import("./agents-web.ts");
      out(
        `on your tailnet, for ${on.login}'s devices only:\n` +
          `  dashboard  ${phone.phoneAddress(on, token)}\n` +
          `  agents     ${phone.phoneAddress({ ...on, httpsPort: on.httpsPort + 1 }, agentsToken())}\n` +
          "open each once on your phone: they carry their pages' tokens, so keep them to yourself.\n" +
          "Pushes are still approved here, on the Mac. desolate phone off takes both off the tailnet.",
      );
      return EXIT.ok;
    }
    if (what === "dev") {
      const domain = positionals[1];
      if (!domain || positionals.length > 2)
        refuse(
          "which domain's dev servers?",
          "desolate phone dev <domain>   (or: off)",
          EXIT.usage,
        );
      if (domain !== "off") await ready();
      const set = await phone.phoneDev(domain === "off" ? null : domain);
      if ("refused" in set) refuse(set.refused, set.fix);
      out(
        set.dev
          ? `the phone reaches ${set.dev}'s dev servers now (desolate ports lists their addresses), and no other domain's.\n` +
              "They share one name on the tailnet with each other: use it for a domain whose pages you trust, and close its tabs before choosing another."
          : "the phone reaches no dev servers now.",
      );
      return EXIT.ok;
    }
    if (what === "off") {
      await phone.phoneOff();
      out("the dashboard is off your tailnet.");
      return EXIT.ok;
    }
    if (what === "status" && positionals.length <= 1) {
      const on = phone.readPhone();
      out(
        on
          ? `on: https://${on.name}:${on.httpsPort}/ for ${on.login}'s devices (desolate phone on prints it with its token); dev servers: ${on.dev ?? "none (desolate phone dev <domain>)"}`
          : "off: desolate phone on puts the dashboard on your tailnet",
      );
      return EXIT.ok;
    }
    refuse(
      `desolate phone takes on, off, or nothing, not '${what}'`,
      "desolate phone on",
      EXIT.usage,
    );
  }
  if (verb === "down") {
    if (flags(rest, {}).positionals.length > 0)
      refuse(
        "desolate down takes no arguments: it stops every VM (and removes nothing)",
        "desolate down",
        EXIT.usage,
      );
    const { down } = await import("./bootstrap.ts");
    await down(out);
    return EXIT.ok;
  }
  if (verb === "completion") {
    const fs = await import("node:fs");
    const { RELEASE_DIR } = await import("./paths.ts");
    process.stdout.write(fs.readFileSync(`${RELEASE_DIR}/completion.bash`, "utf8"));
    return EXIT.ok;
  }
  if (verb === "editor" && rest[0] === "defaults") {
    // desolate editor defaults [--json] | set <key> <value> | unset <key> | replace (stdin) | reset
    const { values, positionals } = flags(rest.slice(1), {});
    const d = await import("./editor-defaults.ts");
    const [action, key, ...value] = positionals;
    const how =
      "desolate editor defaults [--json] | set <setting> <value> | unset <setting> | replace (a JSON object on stdin) | reset";
    const said = async (settings: Record<string, unknown>) => {
      const done = await d.setDefaults(settings);
      out(
        `editor defaults saved: ${Object.keys(done.settings).length} setting(s); ${done.applied} of ${done.running} running editor(s) have them now (an open editor takes them when its tab is reloaded).`,
      );
    };
    if (action === undefined) {
      const now = d.editorDefaults();
      if (values.json === true) out(JSON.stringify(now));
      else {
        out(
          "Every workspace's editor starts from these. Its own settings, the project's devcontainer and the repository's .vscode/settings.json override them.",
        );
        for (const [k, v] of Object.entries(now)) out(`  ${k}: ${JSON.stringify(v)}`);
        if (!Object.keys(now).length) out("  (none)");
        out(`change: ${how}`);
      }
      return EXIT.ok;
    }
    if (action === "set") {
      if (!key || value.length === 0)
        refuse(
          "set which setting, to what?",
          "desolate editor defaults set workbench.colorTheme Dark+",
          EXIT.usage,
        );
      await said({ ...d.editorDefaults(), [key]: d.valueOf(value.join(" ")) });
      return EXIT.ok;
    }
    if (action === "unset") {
      if (!key)
        refuse("unset which setting?", "desolate editor defaults unset files.autoSave", EXIT.usage);
      const now = d.editorDefaults();
      delete now[key];
      await said(now);
      return EXIT.ok;
    }
    if (action === "replace") {
      let text = "";
      for await (const chunk of process.stdin) text += chunk;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        refuse(
          "that is not JSON",
          'desolate editor defaults replace <<< \'{"files.autoSave": "off"}\'',
          EXIT.usage,
        );
      }
      await said(d.checkDefaults(parsed));
      return EXIT.ok;
    }
    if (action === "reset") {
      await said({ ...d.BUILT_IN });
      return EXIT.ok;
    }
    refuse(`'editor defaults ${action}' is not understood`, how, EXIT.usage);
  }
  if (verb === "editor") {
    const { values, positionals } = flags(rest, { open: { type: "boolean" } });
    const { editor } = await import("./workspaces.ts");
    let url = "";
    await editor(
      positionals[0],
      (line) => {
        url = /(http:\/\/\S+)/.exec(line)?.[1] ?? url;
        out(line);
      },
      values.json === true,
    );
    if (values.open === true && url) openInBrowser(url);
    return 0;
  }
  if (verb === "approve") {
    const { values } = flags(rest, {
      selftest: { type: "boolean" },
      web: { type: "boolean" },
      open: { type: "boolean" },
    });
    if (values.selftest === true) return (await import("./approver.ts")).selftest(out);
    if (values.web === true) {
      // The page's address carries this stack's token: it is the person's to open in a
      // browser on this Mac, and not to paste anywhere else.
      const { ensureDaemon, tokenAddressesSafe } = await import("./daemon.ts");
      await ensureDaemon();
      await tokenAddressesSafe();
      const address = (await import("./approve-web.ts")).approveAddress();
      out(`approvals    ${address}`);
      if (values.open === true) openInBrowser(address);
      return EXIT.ok;
    }
    const { approve } = await import("./push.ts");
    return approve(out);
  }
  if (verb === "events") {
    // JSON lines, one per event, until stopped: for a script to act on (events.ts says how
    // far each kind of event can be believed).
    const { values } = flags(rest, { replay: { type: "string" } });
    const replay = values.replay === undefined ? 0 : Number(values.replay);
    if (!Number.isInteger(replay) || replay < 0)
      refuse("--replay takes a number", "desolate events --replay 20", EXIT.usage);
    const { followEvents } = await import("./daemon.ts");
    // (A reader that stops reading is let go by the daemon, with a "lagged" line: this
    // process does not pile lines up either, it stops when stdout does.)
    process.stdout.on("error", () => process.exit(0));
    await followEvents(
      replay,
      (line) => process.stdout.write(`${forTerminal(line)}\n`),
      (resume) => process.stdout.once("drain", resume),
    );
  }
  if (verb === "issues" || verb === "issue") {
    const { values, positionals } = flags(rest, {});
    const issues = await import("./issues.ts");
    if (verb === "issues") await issues.list(out, values.json === true);
    else if (positionals[0] === "publish" || positionals[0] === "refuse")
      await issues.decide(positionals[0], positionals[1], out);
    else
      refuse(
        "desolate issue what?",
        "desolate issues | desolate issue publish <id> | desolate issue refuse <id>",
        EXIT.usage,
      );
    return EXIT.ok;
  }
  if (verb === "agent") {
    // `--` ends desolate's own flags: everything after it is the agent's command.
    const dash = rest.indexOf("--");
    const own = dash >= 0 ? rest.slice(0, dash) : rest;
    const command = dash >= 0 ? rest.slice(dash + 1) : [];
    const { values, positionals } = flags(own, {
      name: { type: "string" },
      checkout: { type: "string" },
    });
    const agents = await import("./agent.ts");
    const [sub, where] = positionals;
    if (sub === "start")
      await agents.start(
        where,
        {
          name: values.name as string | undefined,
          checkout: values.checkout as string | undefined,
        },
        command,
        out,
        values.json === true,
      );
    else if (sub === "attach")
      return agents.attach(where, { name: values.name as string | undefined });
    else if (sub === "list") await agents.list(where, out, values.json === true);
    else if (sub === "stop")
      await agents.stop(where, { name: values.name as string | undefined }, out);
    else if (sub === "log") await agents.log(where, { name: values.name as string | undefined });
    else if (sub === "say") {
      // A line typed into it, as at its terminal, ended with Enter: for a phone, or a script.
      if (command.length === 0)
        refuse(
          "say what?",
          `desolate agent say ${where ?? "<domain>/<workspace>"} -- <text>`,
          EXIT.usage,
        );
      await agents.say(
        where!,
        values.name as string | undefined,
        Buffer.from(`${command.join(" ")}\r`),
      );
      out("said.");
    } else
      refuse(
        "desolate agent what?",
        "desolate agent start|attach|list|log|say|stop <domain>/<workspace> [--name <n>]",
        EXIT.usage,
      );
    return EXIT.ok;
  }
  if (verb === "task" || verb === "factory") {
    // Recipes now: scripts of ordinary desolate commands, to read, run and change.
    refuse(
      `'desolate ${verb}' is a recipe now`,
      verb === "task"
        ? 'release/recipes/claude.sh <domain> "<what to do>"   (or agent.sh, for any other program; see release/recipes/README.md)'
        : "release/recipes/issues.sh or release/recipes/suede.sh   (see release/recipes/README.md)",
      EXIT.usage,
    );
  }
  if (verb === "suede" && rest[0] === "changed") {
    const { values, positionals } = flags(rest.slice(1), { from: { type: "string" } });
    const { rootctl } = await import("./stack.ts");
    const changed = await rootctl<
      { dir: string; remote: string | null; branch: string; files: string[] }[]
    >(
      "suede.changed",
      { repo: positionals[0], to: positionals[1], from: values.from ?? null },
      { quiet: true },
    );
    if (values.json === true) out(JSON.stringify(changed));
    else
      for (const c of changed)
        out(
          `  ${c.dir}  ${c.remote ?? "(no remote)"} ${c.branch}  ${c.files.length ? `${c.files.length} file(s) changed` : "unchanged"}`,
        );
    return EXIT.ok;
  }
  if (verb === "upstream") {
    // suede's upstream, desolate's pinned copy, in the git VM; the push waits for approval.
    const { values, positionals } = flags(rest, {
      from: { type: "string" },
      remote: { type: "string" },
      "no-wait": { type: "boolean" },
    });
    const { upstreamCommand } = await import("./upstream.ts");
    return upstreamCommand(positionals, values, out);
  }
  if (verb === "notify") {
    const { values: notifyValues } = flags(rest, { ntfy: { type: "string" } });
    await (await import("./notify.ts")).notify(out, notifyValues.ntfy as string | undefined);
    return EXIT.ok;
  }
  if (verb === "git") {
    // A shell in the git VM, in a browser tab: the address carries this stack's token, and
    // is the person's to open on this Mac.
    const { values: gitValues, positionals: gitArgs } = flags(rest, { open: { type: "boolean" } });
    const repo = gitArgs[0];
    if (repo !== undefined && !parseRepo(repo))
      refuse(`'${repo}' is not a repository`, "desolate git <owner/repo>", EXIT.usage);
    const { ensureGitVm, ensureGitClone } = await import("./git-vm.ts");
    await ensureGitVm(err);
    if (repo) await ensureGitClone(parseRepo(repo)!);
    const { ensureDaemon, tokenAddressesSafe } = await import("./daemon.ts");
    await ensureDaemon();
    await tokenAddressesSafe();
    const address = (await import("./git-web.ts")).gitAddress(repo);
    out(`git          ${address}`);
    if (gitValues.open === true) openInBrowser(address);
    return EXIT.ok;
  }
  if (verb === "root" && rest[0] === "shell") {
    flags(rest.slice(1), {});
    const { rootShell } = await import("./push.ts");
    return rootShell();
  }
  if (verb === "ports") {
    const { values, positionals } = flags(rest, {});
    const { ports } = await import("./daemon.ts");
    const view = (await ports()).filter((w) => !positionals[0] || w.workspace === positionals[0]);
    if (values.json === true) out(JSON.stringify(view));
    else if (view.length === 0) out("no workspace is running.");
    else
      for (const w of view) {
        out(w.workspace);
        if (w.forwarded.length === 0)
          out("  nothing is listening yet: start a dev server in it and its URL appears here");
        for (const f of w.forwarded)
          out(`  ${f.url}${f.phone ? `   on your phone: ${f.phone}` : ""}`);
        for (const r of w.reserved)
          out(
            `  port ${r.port} ${r.why.startsWith("listening in the workspace") ? "is NOT forwarded" : "is kept taken here"}: ${r.why}`,
          );
      }
    return EXIT.ok;
  }
  if (verb === "exec") {
    const split = rest.indexOf("--");
    const { values, positionals } = flags(split < 0 ? rest : rest.slice(0, split), {
      checkout: { type: "string" },
      vm: { type: "boolean" },
    });
    const { exec } = await import("./workspaces.ts");
    return exec(positionals[0], split < 0 ? positionals.slice(1) : rest.slice(split + 1), {
      checkout: values.checkout as string | undefined,
      vm: values.vm === true,
    });
  }
  throw new Refusal(`desolate has no command '${verb}'`, "desolate help", EXIT.usage);
};

declare namespace main {
  /** the help, asked for (exit 0) or for want of a verb (exit 64, a usage error) */
  export type Help = [
    Expect<Invoke<typeof printed, [run: typeof main, args: [argv: ["help"]]]>["value"], "=", 0>,
    Expect<
      Invoke<typeof printed, [run: typeof main, args: [argv: ["help"]]]>["stdout"],
      "startsWith",
      "desolate: develop in VMs of their own."
    >,
    Expect<Invoke<typeof printed, [run: typeof main, args: [argv: []]]>["value"], "=", 64>,
  ];
  /** what is refused before anything is asked of a VM or the root: each a usage error (exit 64)
   *  that names the spelling that works */
  export type Refuses = Table<
    typeof refusalOf,
    [
      [
        args: [f: typeof main, args: [argv: ["nosuchverb"]]],
        expected: {
          message: "desolate has no command 'nosuchverb'";
          fix: "desolate help";
          code: 64;
        },
      ],
      [
        args: [f: typeof main, args: [argv: ["list", "--frobnicate"]]],
        condition: "matches",
        expected: { fix: "desolate help"; code: 64 },
      ],
      [
        args: [f: typeof main, args: [argv: ["push", "acme", "acme/web", "main", "--force"]]],
        condition: "matches",
        expected: { fix: "desolate help"; code: 64 },
      ],
      [
        args: [
          f: typeof main,
          args: [argv: ["clone", "acme/web", "--domain", "web", "--no-domain"]],
        ],
        expected: {
          message: "--domain and --no-domain say opposite things";
          fix: "give one of them";
          code: 64;
        },
      ],
      [
        args: [
          f: typeof main,
          args: [argv: ["review", "acme", "acme/web", "main", "--against", "upstream"]],
        ],
        condition: "matches",
        expected: { message: "--against 'upstream' is not understood"; code: 64 },
      ],
      [
        args: [f: typeof main, args: [argv: ["git", "../etc"]]],
        expected: {
          message: "'../etc' is not a repository";
          fix: "desolate git <owner/repo>";
          code: 64;
        },
      ],
      [
        args: [f: typeof main, args: [argv: ["offers", "dismiss", "acme"]]],
        condition: "matches",
        expected: { message: "dismiss which offer?"; code: 64 },
      ],
      [
        args: [f: typeof main, args: [argv: ["down", "now"]]],
        condition: "matches",
        expected: {
          message: "desolate down takes no arguments: it stops every VM (and removes nothing)";
          code: 64;
        },
      ],
      [
        args: [f: typeof main, args: [argv: ["events", "--replay=lots"]]],
        expected: {
          message: "--replay takes a number";
          fix: "desolate events --replay 20";
          code: 64;
        },
      ],
      [
        args: [f: typeof main, args: [argv: ["up", "acme", "--memory", "lots"]]],
        condition: "matches",
        expected: { message: "--memory 'lots' is not an amount"; code: 64 },
      ],
      [
        args: [f: typeof main, args: [argv: ["issue", "frob"]]],
        condition: "matches",
        expected: { message: "desolate issue what?"; code: 64 },
      ],
      [
        args: [f: typeof main, args: [argv: ["task"]]],
        condition: "matches",
        expected: { message: "'desolate task' is a recipe now"; code: 64 },
      ],
    ]
  >;
  /** after `--`, the words are the agent's command, not desolate's flags */
  export type DashDash = Expect<
    Invoke<
      typeof refusalOf,
      [f: typeof main, args: [argv: ["agent", "frob", "--", "--force", "--json"]]]
    >,
    "=",
    {
      message: "desolate agent what?";
      fix: "desolate agent start|attach|list|log|say|stop <domain>/<workspace> [--name <n>]";
      code: 64;
    }
  >;
}

// Run only as the command (cli.sh runs this file; realpath, since cli.sh is reached through
// the `desolate` link), never when a test imports it.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Piped into something that stops reading (`desolate list | head -1`): done, not a crash.
  process.stdout.on("error", (error: NodeJS.ErrnoException) =>
    process.exit(error.code === "EPIPE" ? 0 : EXIT.failed),
  );
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof Refusal) {
      err(`desolate: ${error.message}`);
      if (error.fix) err(`  fix: ${error.fix}`);
      process.exitCode = error.code;
    } else {
      err(`desolate: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      process.exitCode = EXIT.failed;
    }
  }
}
