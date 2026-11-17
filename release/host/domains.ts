// `desolate domain ...`: create, add, show.
import { EXIT, refuse } from "../shared/exit.ts";
import * as path from "node:path";
import { guest, paths } from "./paths.ts";
import { backend, changeSecrets, ensureProxyUser, revealSecret, rootctl } from "./stack.ts";
import type {
  Expect,
  Given,
  Invoke,
  Mock,
  Table,
} from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { emptyHome } from "../.harness/home.ts";
import type { collect, fakeStack, rootAnswers, rootAsked, said } from "../.harness/host-stack.ts";
import type { refusalOf } from "../.harness/refusal.ts";

type Out = (line: string) => void;

/** One line from stdin; on a terminal, without echo. */
const readSecretLine = (): Promise<string> =>
  new Promise((resolve) => {
    const tty = process.stdin.isTTY;
    if (tty) process.stdin.setRawMode(true);
    let text = "";
    const done = () => {
      if (tty) {
        process.stdin.setRawMode(false);
        process.stderr.write("\n");
      }
      process.stdin.pause();
      resolve(text.replace(/\r?\n$/, ""));
    };
    process.stdin.on("data", (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (tty && (char === "\r" || char === "\n" || char === "\u0004")) return done();
        if (tty && char === "\u0003") process.exit(130);
        if (tty && (char === "\u007f" || char === "\b")) text = text.slice(0, -1);
        else text += char;
      }
      if (!tty && text.includes("\n")) {
        text = text.slice(0, text.indexOf("\n"));
        done();
      }
    });
    process.stdin.on("end", done);
    process.stdin.resume();
  });

/** A domain that has secrets has a CA its workspaces must trust: the running ones take it
 *  now, the others when they start. */
const trustCa = async (domain: string) => {
  const d = await rootctl<{ workspaces: { vm: string; workspace: string; domain?: string }[] }>(
    "domain.show",
    { slug: domain },
    { quiet: true },
  );
  const b = backend();
  const running = new Set(
    (await b.list()).filter((vm) => vm.status === "running").map((vm) => vm.name),
  );
  const { isOwnVm } = await import("./workspaces.ts");
  for (const w of d.workspaces)
    if (running.has(w.vm) && isOwnVm(domain, w))
      await b.exec(w.vm, ["bash", `${guest.release}/workspace/net/trust-ca.sh`], {
        root: true,
        timeoutMs: 120_000,
      });
};

/** --repo, given once or more. */
const repoList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : [];

/** A domain's secrets as the root lists them: names and where each goes, never a value. */
export type SecretListed = {
  name: string;
  hosts: string[];
  headers: string[] | null;
  on: boolean;
  secondsLeft?: number;
};
/** What the secrets page (approve-web.ts) does, as the CLI's `domain <d> secret ...` does:
 *  through the root's control socket, from the host. The value goes from here to the root's
 *  secret store, and nowhere else: not the dashboard, which the root's ordinary user serves. */
export const secretOps = {
  domains: async () =>
    (await rootctl<{ slug: string }[]>("domain.list", {}, { quiet: true })).map((d) => d.slug),
  list: (domain: string) => rootctl<SecretListed[]>("secret.list", { domain }, { quiet: true }),
  set: async (
    domain: string,
    secret: { name: string; value: string; hosts: string[]; headers: string[] },
  ) => {
    await ensureProxyUser(domain);
    const listed = await changeSecrets<SecretListed[]>(domain, "set", secret);
    await trustCa(domain);
    return listed;
  },
  switch: (domain: string, name: string, on: boolean) =>
    changeSecrets<SecretListed[]>(domain, "switch", { name, on }),
  remove: (domain: string, name: string) =>
    changeSecrets<SecretListed[]>(domain, "remove", { name }),
};
export type SecretOps = typeof secretOps;

export const domainCommand = async (
  args: string[],
  values: Record<string, unknown>,
  out: Out,
): Promise<void> => {
  const json = values.json === true;
  const [first, second] = args;
  if (first === "create") {
    if (!second)
      refuse(
        "a domain needs a name",
        'desolate domain create <slug> [--title "..."] [--repo <owner>/<repo>]...',
        EXIT.usage,
      );
    const made = await rootctl<{ slug: string; title: string }>(
      "domain.create",
      { slug: second, title: values.title },
      { quiet: true },
    );
    await ensureProxyUser(made.slug);
    // Its repositories at once: `desolate domain create acme --repo a/x --repo a/y`.
    const repos = repoList(values.repo);
    for (const repo of repos)
      await rootctl("domain.add-repo", { slug: made.slug, repo }, { quiet: true });
    if (json) return out(JSON.stringify({ ...made, repos }));
    return out(
      `created the domain ${made.slug} ("${made.title}")${repos.length ? ` with ${repos.join(", ")}` : ""}.\nnext: ${repos.length ? `desolate up ${made.slug} --branch <branch>` : `desolate domain ${made.slug} add --repo <owner>/<repo>`}`,
    );
  }
  if (!first)
    refuse(
      "which domain?",
      "desolate domain create <slug> | desolate domain <slug> add --repo <owner>/<repo> | desolate domain <slug> show",
      EXIT.usage,
    );
  if (second === "add") {
    if (repoList(values.repo).length) {
      const all = [];
      for (const repo of repoList(values.repo)) {
        const added = await rootctl<{ repo: string; added: boolean; note: string }>(
          "domain.add-repo",
          { slug: first, repo },
          { quiet: true },
        );
        all.push(added);
        if (json) continue;
        out(
          added.added
            ? `${added.repo} is now in the domain ${first}: every workspace in it gets a checkout, borrowing the mirror's objects.`
            : `${added.repo} was already in the domain ${first}.`,
        );
        if (added.note) out(`note: ${added.note}`);
      }
      return out(
        json ? JSON.stringify(all.length === 1 ? all[0] : all) : `next: desolate up ${first}`,
      );
    }
    // The spec's spelling for a secret (section 8): `add --secret NAME --hosts ... [--headers ...]`.
    if (typeof values.secret === "string")
      return domainCommand([first, "secret", "set", values.secret], values, out);
    refuse(
      "add what?",
      `desolate domain ${first} add --repo <owner>/<repo> | add --secret <NAME> --hosts <host>[,...] [--headers <header>[,...]]`,
      EXIT.usage,
    );
  }
  if (second === "spawn") {
    // desolate domain <d> spawn [--max N|none]: how many workspaces its workspaces may have
    // started at once. No limit unless a person sets one; 0 turns it off. Held here, on the Mac
    // (host/spawn.ts); the root is told, to answer early and show it.
    const spawn = await import("./spawn.ts");
    if (values.max !== undefined) {
      const max = values.max === "none" ? null : Number(values.max);
      if (max !== null && (!Number.isInteger(max) || max < 0 || max > 1000))
        refuse(
          `--max '${String(values.max)}' is not a number of workspaces`,
          `desolate domain ${first} spawn --max 2   (0: none; none: no limit)`,
          EXIT.usage,
        );
      await rootctl("domain.spawn", { slug: first, max }, { quiet: true });
      spawn.setMax(first, max);
    } else await rootctl("domain.show", { slug: first }, { quiet: true });
    const max = spawn.maxFor(first);
    if (json) return out(JSON.stringify({ domain: first, max }));
    const how = `in ${first} only, each labelled with who started it`;
    return out(
      max === 0
        ? `${first}: its workspaces cannot start workspaces (desolate domain ${first} spawn --max none lets them again)`
        : max === null
          ? `${first}: its workspaces may start workspaces, ${how}, with no limit (desolate domain ${first} spawn --max <n> sets one; 0 turns it off)`
          : `${first}: its workspaces may have up to ${max} workspace(s) they started at once, ${how}. Each one counts until it is removed.`,
    );
  }
  if (second === "stats") {
    // What the root last wrote for the domain's workspaces to read (desolate domain stats, in
    // one): the same view, here. The root's word, and so its text is made printable.
    const { readJson } = await import("../shared/json.ts");
    const { statsLines } = await import("../shared/stats.ts");
    await rootctl("domain.show", { slug: first }, { quiet: true });
    const stats = readJson<unknown>(path.join(paths.inbox(first), "domain.json"), null);
    if (stats === null)
      refuse(
        `the root has not written ${first}'s stats yet`,
        "desolate doctor (is the root's state service up?)",
      );
    if (json) return out(JSON.stringify(stats));
    for (const line of statsLines(stats)) out(line);
    return;
  }
  if (second === "size") {
    // desolate domain <d> size [--cpus N] [--memory 8g] [--disk 60g] [--clear]
    const { sizeFlags, stackDefaults } = await import("./workspaces.ts");
    const { describe, merge } = await import("../shared/size.ts");
    const given =
      values.clear === true
        ? null
        : values.cpus !== undefined || values.memory !== undefined || values.disk !== undefined
          ? sizeFlags(values)
          : undefined;
    const set = await rootctl<{
      domain: string;
      size: Partial<import("../shared/size.ts").Size> | null;
    }>("domain.size", { slug: first, size: given }, { quiet: true });
    if (json) return out(JSON.stringify({ ...set, effective: merge(set.size, stackDefaults()) }));
    return out(
      `${first}: new workspaces get ${describe(merge(set.size, stackDefaults()))}${set.size ? "" : " (the stack's defaults, from this Mac)"}. Existing ones keep what they were made with.`,
    );
  }
  if (second === "env") {
    // desolate domain <d> env [--from <owner/repo>]   (section 4.5, way 1; `compose` is not built)
    if (args[2] === "compose")
      refuse(
        "composing one environment from several specs is not built yet",
        `choose one repository's: desolate domain ${first} env --from <owner>/<repo>`,
      );
    const env = await rootctl<{ env: string | null; repos: string[] }>(
      "domain.env",
      { slug: first, repo: typeof values.from === "string" ? values.from : undefined },
      { quiet: true },
    );
    if (json) return out(JSON.stringify(env));
    return out(
      env.env
        ? `${first}: its workspaces run ${env.env}'s devcontainer.json. (New workspaces; an existing one keeps what it was made with.)`
        : `${first}: its workspaces run the devcontainer.json of the first checkout that has one${env.repos.length > 1 ? `. To choose: desolate domain ${first} env --from <owner>/<repo>` : ""}.`,
    );
  }
  if (second === "net") {
    // desolate domain <d> net [show] | open | enforce | allow <host>... | deny <host>... | allow-internal <ip>
    const [, , action, ...rest] = args;
    type Policy = { mode: string; hosts: string[]; internal: string[] };
    if (action === "recommend") {
      type Ranked = { host: string; count: number }[];
      const r = await rootctl<{ mode: string; listed: string[]; reached: Ranked; refused: Ranked }>(
        "net.recommend",
        { domain: first },
        { quiet: true },
      );
      if (json) return out(JSON.stringify(r));
      const names = (list: Ranked) => list.map((entry) => entry.host).join(" ");
      if (r.reached.length === 0 && r.refused.length === 0)
        return out(
          `${first}: its workspaces have reached nothing that is not already listed${r.listed.length ? ` (${r.listed.length} listed)` : ""}.`,
        );
      if (r.reached.length) {
        out(
          `${first} (${r.mode}): hosts its workspaces reached that are not on its list, most used first:`,
        );
        for (const entry of r.reached.slice(0, 60))
          out(`  ${String(entry.count).padStart(5)}  ${entry.host}`);
        out(
          `to keep reaching them once the network is enforced:\n  desolate domain ${first} net allow ${names(r.reached.slice(0, 60))}\n  desolate domain ${first} net enforce`,
        );
      }
      if (r.refused.length) {
        out(`refused for not being on the list:`);
        for (const entry of r.refused.slice(0, 60))
          out(`  ${String(entry.count).padStart(5)}  ${entry.host}`);
        out(
          `to allow them:\n  desolate domain ${first} net allow ${names(r.refused.slice(0, 60))}`,
        );
      }
      return out("Read the list before you allow it: a workspace chooses what it asks for.");
    }
    const change =
      action === "open" || action === "enforce"
        ? { mode: action }
        : action === "allow"
          ? { allow: rest }
          : action === "deny"
            ? { deny: rest }
            : action === "allow-internal"
              ? { internal: rest }
              : null;
    if (action && action !== "show" && !change)
      refuse(
        `'net ${action}' is not understood`,
        `desolate domain ${first} net show | open | enforce | allow <host>... | deny <host>... | allow-internal <address> | recommend`,
        EXIT.usage,
      );
    const policy = await rootctl<Policy>(
      "net.policy",
      { domain: first, change: change ?? undefined },
      { quiet: true },
    );
    if (json) return out(JSON.stringify(policy));
    out(
      `${first}: ${policy.mode === "enforce" ? `only these hosts are reachable: ${policy.hosts.join(", ") || "(none)"}` : "any public host is reachable (open). Its workspaces still reach nothing internal"}`,
    );
    if (policy.mode === "open" && policy.hosts.length)
      out(`  listed, for when it is enforced: ${policy.hosts.join(", ")}`);
    if (policy.internal.length)
      out(`  internal addresses it may reach: ${policy.internal.join(", ")}`);
    return;
  }
  if (second === "secret") {
    await ensureProxyUser(first);
    // desolate domain <d> secret [list] | set <NAME> --hosts a,b [--headers h,...] | rm <NAME>
    const [, , action, name] = args;
    type Listed = {
      name: string;
      hosts: string[];
      headers: string[] | null;
      on: boolean;
      secondsLeft?: number;
    };
    const usage = `desolate domain ${first} secret list | set <NAME> --hosts <host>[,...] [--headers <header>[,...]] | copy <NAME> --from <domain> | off <NAME> | on <NAME> [--ttl 30m] | rm <NAME> | show <NAME>`;
    const left = (seconds: number) =>
      seconds >= 7200
        ? `${Math.round(seconds / 3600)} h`
        : seconds >= 120
          ? `${Math.round(seconds / 60)} min`
          : `${seconds} s`;
    const stateOf = (s: Listed) =>
      !s.on ? "OFF" : s.secondsLeft !== undefined ? `on for ${left(s.secondsLeft)} more` : "on";
    const csv = (value: unknown) =>
      typeof value === "string"
        ? value
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
        : [];
    if (action === "on" || action === "off") {
      if (!name) refuse("which secret?", usage, EXIT.usage);
      let ttlSeconds: number | undefined;
      if (values.ttl !== undefined) {
        const match = /^(\d+)([smhd])$/.exec(String(values.ttl));
        if (!match || action === "off")
          refuse(
            action === "off"
              ? "--ttl goes with `secret on`"
              : `'${String(values.ttl)}' is not a time to live`,
            `desolate domain ${first} secret on ${name} --ttl 30m   (s, m, h or d)`,
            EXIT.usage,
          );
        ttlSeconds =
          Number(match![1]) *
          { s: 1, m: 60, h: 3600, d: 86400 }[match![2] as "s" | "m" | "h" | "d"];
      }
      const switched = (
        await changeSecrets<Listed[]>(first, "switch", { name, on: action === "on", ttlSeconds })
      ).find((s) => s.name === name)!;
      if (json) return out(JSON.stringify(switched));
      return out(
        switched.on
          ? `${name} is ${stateOf(switched)}${switched.secondsLeft !== undefined ? ", then off" : ""}.`
          : `${name} is OFF: its value goes nowhere, and a request that carries its name toward ${switched.hosts.join(", ")} is refused. To switch it on: desolate domain ${first} secret on ${name} [--ttl 30m]`,
      );
    }
    if (action === "show") {
      // Its value, to this terminal: the one way back out of the root's store, for the person
      // on the Mac (who controls the root VM anyway). Only the value goes to stdout, so
      // `$(desolate domain <d> secret show <NAME>)` is the value itself.
      if (!name) refuse("which secret?", usage, EXIT.usage);
      const value = await revealSecret(first, name);
      if (json) return out(JSON.stringify({ name, value }));
      if (process.stderr.isTTY)
        process.stderr.write(
          `the value of ${name}, held in the root for the domain ${first} (shown here only):\n`,
        );
      return out(value);
    }
    if (action === "copy") {
      // desolate domain <d> secret copy <NAME> --from <other>: the value stays in the root.
      if (!name || typeof values.from !== "string")
        refuse(
          "copy which secret, from which domain?",
          `desolate domain ${first} secret copy <NAME> --from <domain>`,
          EXIT.usage,
        );
      const copied = (
        await changeSecrets<Listed[]>(first, "copy", { name, from: values.from })
      ).find((s) => s.name === name)!;
      await trustCa(first);
      if (json) return out(JSON.stringify(copied));
      return out(
        `${copied.name} is held for the domain ${first} too, copied from ${values.from} inside the root (its value went nowhere else). It is put in place on the way to: ${copied.hosts.join(", ")}${copied.headers ? ` (in the header${copied.headers.length > 1 ? "s" : ""} ${copied.headers.join(", ")} only)` : ""}.`,
      );
    }
    if (action === "set" || action === "rm") {
      if (!name) refuse("which secret?", usage, EXIT.usage);
      if (action === "set") {
        // The value comes on stdin, never as an argument: arguments are visible to every
        // process on the machine and are kept in shell history.
        if (process.stdin.isTTY)
          process.stderr.write(`Paste the value of ${name} and press Enter (it is not shown): `);
        const value = await readSecretLine();
        const set = (
          await changeSecrets<Listed[]>(first, "set", {
            name,
            value,
            hosts: csv(values.hosts),
            headers: csv(values.headers),
          })
        ).find((s) => s.name === name)!;
        await trustCa(first);
        if (json) return out(JSON.stringify(set));
        out(
          `${set.name} is held in the root for the domain ${first}. Its workspaces send the name; the value is put in its place on the way to: ${set.hosts.join(", ")}${set.headers ? ` (in the header${set.headers.length > 1 ? "s" : ""} ${set.headers.join(", ")} only)` : ""}.`,
        );
        return out(`in a workspace: export SOME_API_KEY=${set.name}   (the name is not a secret)`);
      }
      const existed = (
        await rootctl<Listed[]>("secret.list", { domain: first }, { quiet: true })
      ).some((s) => s.name === name);
      await changeSecrets<Listed[]>(first, "remove", { name });
      return out(
        json
          ? JSON.stringify({ existed })
          : existed
            ? `${name} is no longer held for the domain ${first}.`
            : `the domain ${first} had no secret named ${name}.`,
      );
    }
    if (action && action !== "list")
      refuse(`'secret ${action}' is not understood`, usage, EXIT.usage);
    const listed = await rootctl<Listed[]>("secret.list", { domain: first }, { quiet: true });
    if (json) return out(JSON.stringify(listed));
    if (listed.length === 0)
      return out(`the domain ${first} has no secrets. To add one: ${usage.split(" | ")[1]}`);
    for (const s of listed)
      out(
        `${s.name}  ->  ${s.hosts.join(", ")}${s.headers ? `  (headers: ${s.headers.join(", ")})` : ""}${stateOf(s) === "on" ? "" : `  [${stateOf(s)}]`}`,
      );
    return;
  }
  if (second === "show" || second === undefined) {
    const d = await rootctl<{
      slug: string;
      title: string;
      repos: string[];
      workspaces: { workspace: string; state: string }[];
    }>("domain.show", { slug: first }, { quiet: true });
    if (json) return out(JSON.stringify(d));
    out(`${d.slug}  "${d.title}"`);
    out(`  repositories: ${d.repos.join(", ") || "none"}`);
    return out(
      `  workspaces: ${d.workspaces.map((w) => `${w.workspace} (${w.state})`).join(", ") || "none"}`,
    );
  }
  refuse(
    `'desolate domain ${first} ${second}' is not a command`,
    `desolate domain ${first} add --repo <owner>/<repo> | desolate domain ${first} show | desolate domain ${first} secret ...`,
    EXIT.usage,
  );
};

declare namespace domainCommand {
  /** what is refused before the root is asked: each a usage error (exit 64) with its spelling */
  export type Usage = Table<
    typeof refusalOf,
    [
      [
        args: [
          run: typeof domainCommand,
          args: [args: ["create"], values: {}, out: typeof collect],
        ],
        expected: {
          message: "a domain needs a name";
          fix: 'desolate domain create <slug> [--title "..."] [--repo <owner>/<repo>]...';
          code: 64;
        },
      ],
      [
        args: [run: typeof domainCommand, args: [args: [], values: {}, out: typeof collect]],
        condition: "matches",
        expected: { message: "which domain?"; code: 64 },
      ],
      [
        args: [
          run: typeof domainCommand,
          args: [args: ["acme", "add"], values: {}, out: typeof collect],
        ],
        condition: "matches",
        expected: { message: "add what?"; code: 64 },
      ],
      [
        args: [
          run: typeof domainCommand,
          args: [args: ["acme", "spawn"], values: { max: "-1" }, out: typeof collect],
        ],
        expected: {
          message: "--max '-1' is not a number of workspaces";
          fix: "desolate domain acme spawn --max 2   (0: none; none: no limit)";
          code: 64;
        },
      ],
      [
        args: [
          run: typeof domainCommand,
          args: [args: ["acme", "net", "open-everything"], values: {}, out: typeof collect],
        ],
        condition: "matches",
        expected: { message: "'net open-everything' is not understood"; code: 64 },
      ],
      [
        args: [
          run: typeof domainCommand,
          args: [args: ["acme", "frobnicate"], values: {}, out: typeof collect],
        ],
        condition: "matches",
        expected: { message: "'desolate domain acme frobnicate' is not a command"; code: 64 },
      ],
    ]
  >;

  /** a domain, made with its repositories at once, each added in the order given */
  export type Creates = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<
        typeof rootAnswers,
        [answers: { "domain.create": { slug: "acme"; title: "Acme" }; "domain.add-repo": {} }]
      >,
      Invoke<
        typeof domainCommand,
        [
          args: ["create", "acme"],
          values: { title: "Acme"; repo: ["acme/web", "acme/api"] },
          out: typeof collect,
        ]
      >,
    ],
    [
      Expect<
        Invoke<typeof said>,
        "=",
        [
          'created the domain acme ("Acme") with acme/web, acme/api.',
          "next: desolate up acme --branch <branch>",
        ]
      >,
      Expect<
        Invoke<typeof rootAsked>,
        "matches",
        [
          { op: "domain.create" },
          { op: "domain.add-repo"; args: { repo: "acme/web" } },
          { op: "domain.add-repo"; args: { repo: "acme/api" } },
        ]
      >,
    ]
  >;

  /** the limit on workspaces its workspaces start: none by default, a number, or off */
  export type SpawnLimit = Given<
    [
      Invoke<typeof emptyHome>,
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<typeof rootAnswers, [answers: { "domain.spawn": {}; "domain.show": {} }]>,
    ],
    [
      Given<
        Invoke<typeof domainCommand, [args: ["acme", "spawn"], values: {}, out: typeof collect]>,
        Expect<
          Invoke<typeof said>,
          "=",
          [
            "acme: its workspaces may start workspaces, in acme only, each labelled with who started it, with no limit (desolate domain acme spawn --max <n> sets one; 0 turns it off)",
          ]
        >
      >,
      Given<
        Invoke<
          typeof domainCommand,
          [args: ["acme", "spawn"], values: { max: "2" }, out: typeof collect]
        >,
        Expect<
          Invoke<typeof said>,
          "=",
          [
            "acme: its workspaces may have up to 2 workspace(s) they started at once, in acme only, each labelled with who started it. Each one counts until it is removed.",
          ]
        >
      >,
      Given<
        Invoke<
          typeof domainCommand,
          [args: ["acme", "spawn"], values: { max: "0" }, out: typeof collect]
        >,
        Expect<
          Invoke<typeof said>,
          "=",
          [
            "acme: its workspaces cannot start workspaces (desolate domain acme spawn --max none lets them again)",
          ]
        >
      >,
    ]
  >;

  /** the network rules, as the root holds them */
  export type Net = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<
        typeof rootAnswers,
        [
          answers: {
            "net.policy": {
              mode: "enforce";
              hosts: ["registry.npmjs.org", "pypi.org"];
              internal: ["10.0.0.5"];
            };
          },
        ]
      >,
      Invoke<typeof domainCommand, [args: ["acme", "net"], values: {}, out: typeof collect]>,
    ],
    Expect<
      Invoke<typeof said>,
      "=",
      [
        "acme: only these hosts are reachable: registry.npmjs.org, pypi.org",
        "  internal addresses it may reach: 10.0.0.5",
      ]
    >
  >;

  /** secrets by name, where each may be sent, and whether it is switched on */
  export type Secrets = Given<
    [
      Mock<"./stack.ts", typeof fakeStack>,
      Invoke<
        typeof rootAnswers,
        [
          answers: {
            "secret.list": [
              {
                name: "ACME-OPENAI-KEY";
                hosts: ["api.openai.com"];
                headers: ["authorization"];
                on: false;
              },
              {
                name: "ACME-NPM-TOKEN";
                hosts: ["registry.npmjs.org"];
                headers: null;
                on: true;
                secondsLeft: 1800;
              },
            ];
          },
        ]
      >,
      Invoke<typeof domainCommand, [args: ["acme", "secret"], values: {}, out: typeof collect]>,
    ],
    Expect<
      Invoke<typeof said>,
      "=",
      [
        "ACME-OPENAI-KEY  ->  api.openai.com  (headers: authorization)  [OFF]",
        "ACME-NPM-TOKEN  ->  registry.npmjs.org  [on for 30 min more]",
      ]
    >
  >;
  /** a time to live is a number and a unit, and only for switching one on */
  export type Ttl = Given<
    [Mock<"./stack.ts", typeof fakeStack>, Invoke<typeof rootAnswers, [answers: {}]>],
    [
      Expect<
        Invoke<
          typeof refusalOf,
          [
            run: typeof domainCommand,
            args: [
              args: ["acme", "secret", "on", "ACME-NPM-TOKEN"],
              values: { ttl: "forever" },
              out: typeof collect,
            ],
          ]
        >,
        "=",
        {
          message: "'forever' is not a time to live";
          fix: "desolate domain acme secret on ACME-NPM-TOKEN --ttl 30m   (s, m, h or d)";
          code: 64;
        }
      >,
      Expect<
        Invoke<
          typeof refusalOf,
          [
            run: typeof domainCommand,
            args: [
              args: ["acme", "secret", "off", "ACME-NPM-TOKEN"],
              values: { ttl: "30m" },
              out: typeof collect,
            ],
          ]
        >,
        "matches",
        { message: "--ttl goes with `secret on`"; code: 64 }
      >,
    ]
  >;
}
