// A project's .env into a domain's secrets, on the Mac (shared/envfile.ts judges each entry):
// `desolate domain <d> secret import <file>`, and the secrets page's Import (approve-web.ts).
// The values are read here, on the host, and go to the root's secret store as `secret set`'s
// do (domains.ts secretOps); none is ever printed or sent to a page. What the person decides
// about a key is remembered for the domain (~/.desolate/state/env-import/<domain>.json: keys
// and where they go, never a value), so the next import asks nothing it asked before.
import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT, refuse } from "../shared/exit.ts";
import { readJson } from "../shared/json.ts";
import {
  ANYWHERE_COST,
  keepApart,
  parseEnv,
  planEnv,
  rewriteEnv,
  secretName,
} from "../shared/envfile.ts";
import type { Decision, PlanRow } from "../shared/envfile.ts";
import { paths } from "./paths.ts";
import type { SecretListed, SecretOps } from "./domains.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Given, Invoke, Throws } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { emptyHome, readState } from "../.harness/home.ts";
import type { quietOps } from "../.harness/host-env-import.ts";

/** A .env's size, at most: one a person writes by hand. */
export const ENV_MAX = 64 * 1024;

const choicesFile = (domain: string) => path.join(paths.state, "env-import", `${domain}.json`);
export const rememberedOf = (domain: string): Record<string, Decision> =>
  readJson<Record<string, Decision>>(choicesFile(domain), {});
const remember = (domain: string, decided: Record<string, Decision>) => {
  if (Object.keys(decided).length === 0) return;
  fs.mkdirSync(path.dirname(choicesFile(domain)), { recursive: true, mode: 0o700 });
  const merged = { ...rememberedOf(domain), ...decided };
  fs.writeFileSync(choicesFile(domain), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
};

/** What the person decides about one key: on the page, or with `--choose`. */
export type Choice = {
  key: string;
  kind: "secret" | "value" | "local";
  hosts?: string[];
  headers?: string[] | null;
};

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const HEADER = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A choice, checked: a secret names one host or more (a name, or `*.` and a name), and its
 *  headers, if any, are header names. The decision it stands for. */
export const checkChoice = (choice: Choice): Decision => {
  if (choice.kind === "value" || choice.kind === "local") return { kind: choice.kind };
  if (choice.kind !== "secret")
    refuse(`${choice.key}: not a choice desolate knows`, "secret, value or local", EXIT.usage);
  const hosts = (choice.hosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (hosts.length === 0 || !hosts.every((h) => HOST.test(h)))
    refuse(
      `${choice.key}: a secret names the hosts it may go to (a name, or *. and a name), not '${hosts.join(",").slice(0, 80)}'`,
      `--choose ${choice.key}=secret:api.example.com[@authorization]`,
      EXIT.usage,
    );
  const headers =
    choice.headers === null || choice.headers === undefined || choice.headers.length === 0
      ? null
      : choice.headers.map((h) => h.trim().toLowerCase());
  if (headers && !headers.every((h) => HEADER.test(h)))
    refuse(
      `${choice.key}: '${headers.join(",").slice(0, 80)}' is not a list of header names`,
      `--choose ${choice.key}=secret:api.example.com@authorization`,
      EXIT.usage,
    );
  return { kind: "secret", hosts, headers };
};

declare namespace checkChoice {
  export type Secret = Expect<
    Invoke<
      typeof checkChoice,
      [
        choice: {
          key: "K";
          kind: "secret";
          hosts: ["API.example.com", "*.example.com"];
          headers: ["Authorization"];
        },
      ]
    >,
    "=",
    { kind: "secret"; hosts: ["api.example.com", "*.example.com"]; headers: ["authorization"] }
  >;
  /** no headers: anywhere in the request */
  export type Anywhere = Expect<
    Invoke<
      typeof checkChoice,
      [choice: { key: "K"; kind: "secret"; hosts: ["api.example.com"]; headers: [] }]
    >,
    "=",
    { kind: "secret"; hosts: ["api.example.com"]; headers: null }
  >;
  /** a secret with nowhere to go, or a host that is a whole domain's suffix, is refused */
  export type NoHosts = Throws<
    Invoke<typeof checkChoice, [choice: { key: "K"; kind: "secret"; hosts: [] }]>,
    "K: a secret names the hosts it may go to (a name, or *. and a name), not ''"
  >;
  export type BareSuffix = Throws<
    Invoke<typeof checkChoice, [choice: { key: "K"; kind: "secret"; hosts: ["*"] }]>,
    "K: a secret names the hosts it may go to (a name, or *. and a name), not '*'"
  >;
}

/** `--choose KEY=secret:host[,host][@header[,header]]`, `--choose KEY=value`, `KEY=local`. */
export const parseChoose = (spec: string): Choice => {
  const match = /^([A-Za-z_][A-Za-z0-9_.]*)=(secret:([^@]*)(@(.*))?|value|local)$/.exec(
    spec.trim(),
  );
  if (!match)
    refuse(
      `--choose '${spec.slice(0, 80)}' is not understood`,
      "--choose KEY=secret:host[,host][@header[,header]]   or   --choose KEY=value",
      EXIT.usage,
    );
  const [, key, what, hosts, , headers] = match;
  if (what === "value" || what === "local") return { key: key!, kind: what };
  return {
    key: key!,
    kind: "secret",
    hosts: hosts!.split(","),
    headers: headers === undefined ? null : headers.split(",").filter(Boolean),
  };
};

declare namespace parseChoose {
  export type Secret = Expect<
    Invoke<typeof parseChoose, [spec: "MYSTERY_TOKEN=secret:api.mystery.example@authorization"]>,
    "=",
    {
      key: "MYSTERY_TOKEN";
      kind: "secret";
      hosts: ["api.mystery.example"];
      headers: ["authorization"];
    }
  >;
  export type Value = Expect<
    Invoke<typeof parseChoose, [spec: "DESMOS_API_KEY=value"]>,
    "=",
    { key: "DESMOS_API_KEY"; kind: "value" }
  >;
}

/** The plan for a .env, as this domain's earlier choices and these ones decide. Unknown keys
 *  in `choices` are refused; a key still unknown ("ask") stays a value. */
export const decide = (
  domain: string,
  text: string,
  choices: Choice[] = [],
  others: string[] = [],
): { rows: PlanRow[]; decided: Record<string, Decision> } => {
  if (text.length > ENV_MAX)
    refuse(`a .env of at most 64 KiB, not ${text.length} bytes`, "split it", EXIT.usage);
  const rows = planEnv(parseEnv(text), rememberedOf(domain));
  const decided: Record<string, Decision> = {};
  for (const choice of choices) {
    const at = rows.findIndex((r) => r.key === choice.key);
    if (at < 0)
      refuse(`${choice.key} is not in that .env`, "choose only keys the file sets", EXIT.usage);
    const decision = checkChoice(choice);
    const row = rows[at]!;
    const same =
      decision.kind === row.kind &&
      (decision.kind !== "secret" ||
        (JSON.stringify(decision.hosts) === JSON.stringify(row.hosts) &&
          JSON.stringify(decision.headers) === JSON.stringify(row.headers ?? null)));
    if (same) continue;
    decided[choice.key] = decision;
    rows[at] =
      decision.kind === "secret"
        ? {
            key: row.key,
            kind: "secret",
            name: secretName(row.key),
            hosts: decision.hosts,
            headers: decision.headers,
            by: "remembered",
            why: "as you chose",
            warnings: row.warnings,
          }
        : {
            key: row.key,
            kind: decision.kind,
            by: "remembered",
            why: "as you chose",
            warnings: row.warnings.filter((w) => !/^(only if|its value)/.test(w)),
          };
  }
  // Names apart from each other and from the domain's other secrets (shared/envfile.ts).
  const apart = keepApart(rows, others);
  const names = apart.filter((r) => r.kind === "secret").map((r) => r.name!);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice)
    refuse(`two keys would be the secret ${twice}`, "rename one of them in the .env", EXIT.usage);
  return { rows: apart, decided };
};

declare namespace decide {
  type Fresh = Invoke<typeof emptyHome>;
  /** a choice that differs from the plan is taken, and remembered (keys and hosts, no value) */
  export type Chosen = Given<
    [Fresh],
    [
      Expect<
        Invoke<
          typeof decide,
          [
            domain: "acme",
            text: "MYSTERY_TOKEN=zzz\nPORT=3000\n",
            choices: [{ key: "MYSTERY_TOKEN"; kind: "secret"; hosts: ["api.mystery.example"] }],
          ]
        >,
        "matches",
        {
          rows: [
            {
              key: "MYSTERY_TOKEN";
              kind: "secret";
              name: "MYSTERY-TOKEN";
              hosts: ["api.mystery.example"];
              headers: null;
            },
            { key: "PORT"; kind: "value" },
          ];
          decided: {
            MYSTERY_TOKEN: { kind: "secret"; hosts: ["api.mystery.example"]; headers: null };
          };
        }
      >,
    ]
  >;
  /** a key the file does not set cannot be chosen */
  export type NotThere = Given<
    [Fresh],
    [
      Throws<
        Invoke<
          typeof decide,
          [domain: "acme", text: "PORT=3000\n", choices: [{ key: "NOPE"; kind: "value" }]]
        >,
        "NOPE is not in that .env"
      >,
    ]
  >;
}

/** Plan, set each secret in the root, remember what was decided, and the .env with names. */
export const importEnv = async (
  ops: Pick<SecretOps, "set" | "list">,
  domain: string,
  text: string,
  choices: Choice[] = [],
): Promise<{ rows: PlanRow[]; env: string; secrets: SecretListed[] }> => {
  const lines = parseEnv(text);
  const others = (await ops.list(domain)).map((s) => s.name);
  const { rows, decided } = decide(domain, text, choices, others);
  const values = new Map<string, string>();
  for (const line of lines) if (line.kind === "entry") values.set(line.key, line.value);
  let secrets: SecretListed[] | null = null;
  // One by one, as `secret set` does. One the root refuses stops the import there, and says
  // which were set before it (each is a whole secret: set again, or removed, by name).
  const done: string[] = [];
  for (const row of rows.filter((r) => r.kind === "secret")) {
    try {
      secrets = await ops.set(domain, {
        name: row.name!,
        value: values.get(row.key)!,
        hosts: row.hosts!,
        headers: row.headers ?? [],
      });
    } catch (error) {
      refuse(
        `${row.key} (${row.name}) was not set: ${(error as Error).message}${done.length ? `. Set before it: ${done.join(", ")}` : ". Nothing was set"}`,
        `change ${row.key} in the plan (--choose ${row.key}=value keeps it a value), and import again`,
      );
    }
    done.push(row.name!);
  }
  remember(domain, decided);
  const env = rewriteEnv(
    lines,
    Object.fromEntries(rows.filter((r) => r.kind === "secret").map((r) => [r.key, r.name!])),
  );
  return { rows, env, secrets: secrets ?? (await ops.list(domain)) };
};

declare namespace importEnv {
  type Fresh = Invoke<typeof emptyHome>;
  /** remembered for the domain: keys and where they go, never a value */
  export type Remembers = Given<
    [
      Fresh,
      Invoke<
        typeof importEnv,
        [
          ops: typeof quietOps,
          domain: "acme",
          text: "MYSTERY_TOKEN=zzz-the-value\n",
          choices: [{ key: "MYSTERY_TOKEN"; kind: "secret"; hosts: ["api.mystery.example"] }],
        ]
      >,
    ],
    [
      Expect<
        Invoke<typeof readState, [name: "env-import/acme.json"]>,
        "=",
        '{\n  "MYSTERY_TOKEN": {\n    "kind": "secret",\n    "hosts": [\n      "api.mystery.example"\n    ],\n    "headers": null\n  }\n}\n'
      >,
    ]
  >;
}

/** The plan, for a person: what becomes a secret and where it goes, what stays a value the
 *  program uses itself, what was not known, and each warning. No value, ever. */
export const describePlan = (rows: PlanRow[]): string[] => {
  const lines: string[] = [];
  const of = (kind: PlanRow["kind"]) => rows.filter((r) => r.kind === kind);
  for (const r of of("secret"))
    lines.push(
      `  secret  ${r.key} -> ${r.name}  to ${r.hosts!.join(", ")}${r.headers ? ` (in ${r.headers.join(", ")} only)` : " (anywhere in the request)"}: ${r.why}${r.headers ? "" : `; ${ANYWHERE_COST}`}`,
    );
  for (const r of of("local"))
    lines.push(`  stays   ${r.key}: ${r.why}. It stays readable in the workspace.`);
  for (const r of of("ask"))
    lines.push(
      `  value?  ${r.key}: ${r.why}. Left a value: --choose ${r.key}=secret:${r.hosts ? `${r.hosts.join(",")}${r.headers ? `@${r.headers.join(",")}` : ""}` : "<host>[@<header>]"} makes it a secret`,
    );
  const plain = of("value").map((r) => r.key);
  if (plain.length) lines.push(`  values  ${plain.join(", ")}`);
  for (const r of rows) for (const w of r.warnings) lines.push(`  ! ${r.key}: ${w}`);
  return lines;
};

declare namespace describePlan {
  /** a secret with no headers says what that costs, beside one in a header that does not; a
   *  token that writes as the person is left a value, with the command that would set it */
  export type Lines = Expect<
    Invoke<
      typeof describePlan,
      [
        rows: [
          {
            key: "OPENAI_API_KEY";
            kind: "secret";
            name: "OPENAI-API-KEY";
            hosts: ["api.openai.com"];
            headers: ["authorization"];
            by: "value";
            why: "an OpenAI key (sk-)";
            warnings: [];
          },
          {
            key: "SERPAPI_API_KEY";
            kind: "secret";
            name: "SERPAPI-API-KEY";
            hosts: ["serpapi.com"];
            headers: null;
            by: "table";
            why: "SerpApi, by its name";
            warnings: [];
          },
          {
            key: "GH_TOKEN";
            kind: "ask";
            hosts: ["api.github.com"];
            headers: ["authorization"];
            by: "table";
            why: "GitHub's API, by its name, which lets its holder write as you";
            warnings: ["leave it out unless the project needs it"];
          },
        ],
      ]
    >,
    "=",
    [
      "  secret  OPENAI_API_KEY -> OPENAI-API-KEY  to api.openai.com (in authorization only): an OpenAI key (sk-)",
      "  secret  SERPAPI_API_KEY -> SERPAPI-API-KEY  to serpapi.com (anywhere in the request): SerpApi, by its name; its value is put anywhere in a request to those hosts, the body included, so a service there that sends back what it is sent, changed in any way, can hand the value to a workspace",
      "  value?  GH_TOKEN: GitHub's API, by its name, which lets its holder write as you. Left a value: --choose GH_TOKEN=secret:api.github.com@authorization makes it a secret",
      "  ! GH_TOKEN: leave it out unless the project needs it",
    ]
  >;
}
