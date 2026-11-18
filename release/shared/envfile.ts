// A project's .env, turned into a domain's secrets (`desolate domain <d> secret import`, and
// the secrets page's Import): which of its entries become secrets, where each may be sent,
// and the same file with each secret's NAME in place of its value, for the workspace.
//
// What can be a secret: a value the domain's proxy can put in place of its name on the way
// OUT, to a named host (root/proxy/secrets_addon.py). So a key sent in a header, the URL or a
// request body: an API key, an OAuth client secret posted to a token endpoint. Not a value
// the program uses itself (to sign a token, to verify a webhook, AWS's signature, a database
// password on another protocol): the program needs the real value, and the workspace has it.
// Not a value the browser on the Mac uses: that goes nowhere near the proxy.
//
// How an entry is judged, first to answer: what the person chose before (remembered, per
// domain); the value's own shape (sk-ant-, xoxb-, AKIA...); an OAuth client secret's token
// URL in the same file; a table of known keys by name; the name's ending. What none of these
// can tell is asked, or left a value. Values are read here and never shown: a plan names keys,
// hosts and reasons only.
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";

/** One line of a .env: an entry, or anything else (a comment, a blank, what is not an
 *  entry), kept as it was. */
export type EnvLine =
  | {
      kind: "entry";
      key: string;
      value: string;
      /** How it was written, for writing it back the same way. */
      exported: boolean;
      quote: "" | '"' | "'";
      /** Spaces around `=` (`KEY =value`): read, and pointed out (some parsers do not). */
      spaced: boolean;
      raw: string;
    }
  | { kind: "other"; raw: string };

const ENTRY = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.]*)(\s*)=(\s*)(.*)$/;

/** A .env, line by line. A value: unquoted (to a ` #` comment, trimmed), or in single or
 *  double quotes on one line (double quotes take \n, \", \\). A quote that does not close on
 *  its line leaves the line as it is: not an entry desolate changes. */
export const parseEnv = (text: string): EnvLine[] =>
  text.split(/\r?\n/).map((raw): EnvLine => {
    const match = ENTRY.exec(raw);
    if (!match || raw.trimStart().startsWith("#")) return { kind: "other", raw };
    const [, , exported, key, before, after, rest] = match;
    const spaced = before!.length > 0 || after!.length > 0;
    const quote = rest!.startsWith('"') ? '"' : rest!.startsWith("'") ? "'" : "";
    let value: string;
    if (quote) {
      let end = -1;
      for (let i = 1; i < rest!.length; i++) {
        if (quote === '"' && rest![i] === "\\") {
          i++;
          continue;
        }
        if (rest![i] === quote) {
          end = i;
          break;
        }
      }
      if (end < 0) return { kind: "other", raw };
      const inner = rest!.slice(1, end);
      value =
        quote === '"'
          ? inner.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "r" ? "\r" : c))
          : inner;
    } else value = rest!.replace(/\s+#.*$/, "").trim();
    return { kind: "entry", key: key!, value, exported: Boolean(exported), quote, spaced, raw };
  });

declare namespace parseEnv {
  /** entries as dotenv reads them; comments and blanks kept as lines */
  export type Entries = Expect<
    Invoke<
      typeof parseEnv,
      [text: "# keys\nOPENAI_API_KEY=sk-abc\nexport A=\"x y\"\nB = 'q'\nC=plain # note\n"]
    >,
    "=",
    [
      { kind: "other"; raw: "# keys" },
      {
        kind: "entry";
        key: "OPENAI_API_KEY";
        value: "sk-abc";
        exported: false;
        quote: "";
        spaced: false;
        raw: "OPENAI_API_KEY=sk-abc";
      },
      {
        kind: "entry";
        key: "A";
        value: "x y";
        exported: true;
        quote: '"';
        spaced: false;
        raw: 'export A="x y"';
      },
      {
        kind: "entry";
        key: "B";
        value: "q";
        exported: false;
        quote: "'";
        spaced: true;
        raw: "B = 'q'";
      },
      {
        kind: "entry";
        key: "C";
        value: "plain";
        exported: false;
        quote: "";
        spaced: false;
        raw: "C=plain # note";
      },
      { kind: "other"; raw: "" },
    ]
  >;
  /** a quote that does not close on its line is not an entry desolate touches */
  export type Unclosed = Expect<
    Invoke<typeof parseEnv, [text: 'KEY="-----BEGIN']>,
    "=",
    [{ kind: "other"; raw: 'KEY="-----BEGIN' }]
  >;
}

/** What becomes of an entry. */
export type Decision =
  | { kind: "secret"; hosts: string[]; headers: string[] | null }
  | { kind: "value" }
  /** a value the program uses itself: stays a value, said so */
  | { kind: "local" };

export type PlanRow = {
  key: string;
  /** "ask": nothing could tell; left a value unless the person says. */
  kind: "secret" | "value" | "local" | "ask";
  /** The secret's name: what the workspace's .env holds in its place. */
  name?: string;
  hosts?: string[];
  /** null: anywhere in the request (the URL, the headers, the body). */
  headers?: string[] | null;
  /** How it was judged. */
  by: "remembered" | "value" | "token url" | "table" | "name" | "empty";
  why: string;
  warnings: string[];
};

type Provider = { hosts: string[]; headers: string[] | null; what: string };
const header = (hosts: string[], headers: string[] | null, what: string): Provider => ({
  hosts,
  headers,
  what,
});
const OPENAI = header(["api.openai.com"], ["authorization"], "OpenAI");
const ANTHROPIC = header(["api.anthropic.com"], ["x-api-key", "authorization"], "Anthropic");
const OPENROUTER = header(["openrouter.ai"], ["authorization"], "OpenRouter");
// Google's keys: the SDKs send x-goog-api-key, the REST examples ?key=: anywhere.
const GEMINI = header(["generativelanguage.googleapis.com"], null, "Gemini");
const SLACK = header(["slack.com", "*.slack.com"], ["authorization"], "Slack");
const LLAMA = header(
  ["api.cloud.llamaindex.ai", "api.cloud.eu.llamaindex.ai"],
  ["authorization"],
  "LlamaCloud",
);
const LIVEBLOCKS = header(["api.liveblocks.io"], ["authorization"], "Liveblocks");
const STRIPE = header(["api.stripe.com"], ["authorization"], "Stripe");
const GITHUB_API = header(["api.github.com"], ["authorization"], "GitHub's API");
const HUGGINGFACE = header(
  ["huggingface.co", "*.huggingface.co"],
  ["authorization"],
  "Hugging Face",
);

/** Keys that say what they are by their value. First match wins: the specific before the
 *  general (sk-ant- and sk-or- before sk-). */
const SHAPES: [RegExp, Provider | "value", string][] = [
  [/^sk-ant-/, ANTHROPIC, "an Anthropic key (sk-ant-)"],
  [/^sk-or-/, OPENROUTER, "an OpenRouter key (sk-or-)"],
  [/^sk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}$/, OPENAI, "an OpenAI key (sk-)"],
  [/^(sk|rk)_(live|test)_/, STRIPE, "a Stripe secret key"],
  [/^sk_(dev|prod)_/, LIVEBLOCKS, "a Liveblocks secret key (sk_)"],
  [/^pk_(dev|prod|live|test)_/, "value", "a publishable key (pk_): meant for the browser"],
  [/^xox[abpe]-/, SLACK, "a Slack token (xox)"],
  [/^llx-/, LLAMA, "a LlamaCloud key (llx-)"],
  [/^(gh[pousr]_|github_pat_)/, GITHUB_API, "a GitHub token"],
  [/^hf_/, HUGGINGFACE, "a Hugging Face token (hf_)"],
  [
    /^r8_/,
    header(["api.replicate.com"], ["authorization"], "Replicate"),
    "a Replicate token (r8_)",
  ],
  [/^gsk_/, header(["api.groq.com"], ["authorization"], "Groq"), "a Groq key (gsk_)"],
  [/^xai-/, header(["api.x.ai"], ["authorization"], "xAI"), "an xAI key (xai-)"],
  [
    /^pplx-/,
    header(["api.perplexity.ai"], ["authorization"], "Perplexity"),
    "a Perplexity key (pplx-)",
  ],
  [/^SG\./, header(["api.sendgrid.com"], ["authorization"], "SendGrid"), "a SendGrid key (SG.)"],
  [
    /^re_[A-Za-z0-9]{8,}/,
    header(["api.resend.com"], ["authorization"], "Resend"),
    "a Resend key (re_)",
  ],
  [/^npm_/, header(["registry.npmjs.org"], ["authorization"], "npm"), "an npm token (npm_)"],
  [/^tvly-/, header(["api.tavily.com"], null, "Tavily"), "a Tavily key (tvly-)"],
  [
    /^fc-[0-9a-f]{20,}/,
    header(["api.firecrawl.dev"], ["authorization"], "Firecrawl"),
    "a Firecrawl key (fc-)",
  ],
  [
    /^pcsk_/,
    header(["api.pinecone.io", "*.pinecone.io"], ["api-key"], "Pinecone"),
    "a Pinecone key (pcsk_)",
  ],
  [/^(AKIA|ASIA)[0-9A-Z]{16}$/, "value", "an AWS access key ID: an ID, not the secret"],
];

/** Keys by name, for values with no shape of their own. `local`: the program uses it itself. */
const NAMES: [RegExp, Provider | "value" | "local", string][] = [
  // What a program uses itself: it needs the real value, so it stays one.
  [
    /(^|_)SECRET_ACCESS_KEY$/,
    "local",
    "AWS signs each request with it on this side: it is never sent",
  ],
  [
    /^ZOOM_(VIDEO_)?SDK_SECRET$/,
    "local",
    "Zoom's SDK secret signs tokens on this side: it is never sent",
  ],
  [
    /^(JWT|SESSION|COOKIE|NEXTAUTH|AUTH|APP|FLASK|DJANGO|RAILS)_?SECRET(_KEY|_KEY_BASE)?$|^SECRET_KEY(_BASE)?$/,
    "local",
    "this app signs with it: use a dev-only value",
  ],
  [/(ENCRYPTION|SIGNING|PRIVATE)_KEY$/, "local", "this app signs or encrypts with it"],
  [/WEBHOOK_SECRET$|SIGNING_SECRET$/, "local", "this app checks what others send with it"],
  [
    /PASSWORD$|^DATABASE_URL$|^(POSTGRES|MYSQL|MONGO(DB)?|REDIS)_(URL|URI)$/,
    "local",
    "a database's: its protocol is not HTTP, so the proxy cannot put it in place",
  ],
  [/^ZOOM_(VIDEO_)?SDK_KEY$/, "value", "Zoom's SDK key names the app (its secret is what signs)"],
  [
    /^DESMOS_API_KEY$/,
    "value",
    "the browser loads Desmos with it, on your Mac, outside the proxy (a public key, limited by domain)",
  ],
  // Known services, by name.
  [/OPENROUTER/, OPENROUTER, "OpenRouter"],
  [/OPENAI/, OPENAI, "OpenAI"],
  [/ANTHROPIC|CLAUDE/, ANTHROPIC, "Anthropic"],
  [/GEMINI|GOOGLE_(AI|GENAI|GENERATIVE)/, GEMINI, "Gemini"],
  [/LIVEBLOCKS_SECRET/, LIVEBLOCKS, "Liveblocks"],
  [/LLAMA_?(CLOUD|PARSE|INDEX)/, LLAMA, "LlamaCloud"],
  [/^SLACK_(BOT_|USER_|APP_)?TOKEN$/, SLACK, "Slack"],
  [/STRIPE_(SECRET|RESTRICTED)/, STRIPE, "Stripe"],
  [/^(GITHUB|GH)_(TOKEN|PAT)$/, GITHUB_API, "GitHub's API"],
  [/MISTRAL/, header(["api.mistral.ai"], ["authorization"], "Mistral"), "Mistral"],
  [/COHERE/, header(["api.cohere.com", "api.cohere.ai"], ["authorization"], "Cohere"), "Cohere"],
  [/GROQ/, header(["api.groq.com"], ["authorization"], "Groq"), "Groq"],
  [/DEEPSEEK/, header(["api.deepseek.com"], ["authorization"], "DeepSeek"), "DeepSeek"],
  [/TOGETHER/, header(["api.together.xyz"], ["authorization"], "Together"), "Together"],
  [/PERPLEXITY/, header(["api.perplexity.ai"], ["authorization"], "Perplexity"), "Perplexity"],
  [/REPLICATE/, header(["api.replicate.com"], ["authorization"], "Replicate"), "Replicate"],
  [/(HUGGINGFACE|^HF)_(API_)?(TOKEN|KEY)$/, HUGGINGFACE, "Hugging Face"],
  [/ELEVENLABS/, header(["api.elevenlabs.io"], ["xi-api-key"], "ElevenLabs"), "ElevenLabs"],
  [/ASSEMBLYAI/, header(["api.assemblyai.com"], ["authorization"], "AssemblyAI"), "AssemblyAI"],
  [/DEEPGRAM/, header(["api.deepgram.com"], ["authorization"], "Deepgram"), "Deepgram"],
  [/SENDGRID/, header(["api.sendgrid.com"], ["authorization"], "SendGrid"), "SendGrid"],
  [/RESEND/, header(["api.resend.com"], ["authorization"], "Resend"), "Resend"],
  [
    /POSTMARK/,
    header(
      ["api.postmarkapp.com"],
      ["x-postmark-server-token", "x-postmark-account-token"],
      "Postmark",
    ),
    "Postmark",
  ],
  [/PINECONE/, header(["api.pinecone.io", "*.pinecone.io"], ["api-key"], "Pinecone"), "Pinecone"],
  [/TAVILY/, header(["api.tavily.com"], null, "Tavily"), "Tavily"],
  [/FIRECRAWL/, header(["api.firecrawl.dev"], ["authorization"], "Firecrawl"), "Firecrawl"],
  [/SERPAPI/, header(["serpapi.com"], null, "SerpApi"), "SerpApi"],
  [/^NPM_TOKEN$/, header(["registry.npmjs.org"], ["authorization"], "npm"), "npm"],
];

/** OAuth providers whose token endpoint is well known, for a client secret with no token URL
 *  beside it in the file. */
const TOKEN_HOSTS: [RegExp, string[], string][] = [
  [/^(MICROSOFT|AZURE|ENTRA|MS)_/, ["login.microsoftonline.com"], "Microsoft's token endpoint"],
  [/^GITHUB_/, ["github.com"], "GitHub's token endpoint"],
  [/^GOOGLE_/, ["oauth2.googleapis.com"], "Google's token endpoint"],
  [/^SLACK_/, ["slack.com"], "Slack's token endpoint"],
  [/^DISCORD_/, ["discord.com"], "Discord's token endpoint"],
  [/^ZOOM_/, ["zoom.us"], "Zoom's token endpoint"],
  [/^GITLAB_/, ["gitlab.com"], "GitLab's token endpoint"],
];

/** Names that are not secrets: identifiers, addresses, settings, and what goes to a browser. */
const NOT_SECRET =
  /(_ID|_URL|_URI|_ENDPOINT|_HOST|_HOSTNAME|_PORT|_REGION|_BUCKET|_ALGORITHM|_MINUTES|_SECONDS|_HOURS|_DAYS|_TTL|_TIMEOUT|_ENV|_MODE|_LEVEL|_DEBUG|_CHANNEL|_TENANT|_ORG|_PROJECT|_MODEL|_VERSION|_NAME|_EMAIL|_PATH|_DIR|_FILE|_ORIGIN|_DOMAIN|_BASE|_SCOPE|_SCOPES|PUBLIC_KEY|_PUBLISHABLE_KEY)$|^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_)|_EXPIRE/;
const SECRETISH = /(SECRET|TOKEN|API_?KEY|_KEY|PASSWORD|PASSPHRASE|CREDENTIALS?)$|_SECRET_/;

/** A secret's name, from its key: `OPENAI_API_KEY` is `OPENAI-API-KEY`. Dashes, so the
 *  workspace's .env holds something that is not the variable's own name; at least 8
 *  characters, as the root takes names. */
export const secretName = (key: string): string => {
  const dashed = key
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const named = /^[A-Z]/.test(dashed) ? dashed : `KEY-${dashed}`;
  return (named.length < 8 ? `${named}-SECRET` : named).slice(0, 64);
};

declare namespace secretName {
  export type Names = Table<
    typeof secretName,
    [
      [args: [key: "OPENAI_API_KEY"], expected: "OPENAI-API-KEY"],
      [args: [key: "SLACK_TOKEN"], expected: "SLACK-TOKEN"],
      [args: [key: "API_KEY"], expected: "API-KEY-SECRET"],
      [args: [key: "_2FA_TOKEN"], expected: "KEY-2FA-TOKEN"],
    ]
  >;
}

/** The host of an https URL, or null. */
const hostOf = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

const secretRow = (
  key: string,
  p: { hosts: string[]; headers: string[] | null },
  by: PlanRow["by"],
  why: string,
): PlanRow => ({
  key,
  kind: "secret",
  name: secretName(key),
  hosts: p.hosts,
  headers: p.headers,
  by,
  why,
  warnings: [],
});

/** What becomes of each entry of a .env (its last value, where a key is set twice), judged
 *  as the top of this file says. `remembered`: the person's earlier choices for this domain. */
export const planEnv = (lines: EnvLine[], remembered: Record<string, Decision> = {}): PlanRow[] => {
  const entries = new Map<string, Extract<EnvLine, { kind: "entry" }>>();
  for (const line of lines) if (line.kind === "entry") entries.set(line.key, line);
  const rows: PlanRow[] = [];
  for (const [key, entry] of entries) {
    const value = entry.value;
    const upper = key.toUpperCase();
    const row = ((): PlanRow => {
      const mine = remembered[key];
      if (mine)
        return mine.kind === "secret"
          ? secretRow(key, mine, "remembered", "as you chose before")
          : { key, kind: mine.kind, by: "remembered", why: "as you chose before", warnings: [] };
      if (value === "") return { key, kind: "value", by: "empty", why: "empty", warnings: [] };
      // A client secret, and its token endpoint in the same file: it is posted there.
      const client = /^(.*)_CLIENT_SECRET$/.exec(upper);
      if (client) {
        const prefix = client[1]!;
        for (const suffix of ["_TOKEN_URL", "_TOKEN_ENDPOINT", "_TOKEN_URI"]) {
          const url = [...entries.values()].find((e) => e.key.toUpperCase() === prefix + suffix);
          const host = url ? hostOf(url.value) : null;
          if (host)
            return secretRow(
              key,
              { hosts: [host], headers: null },
              "token url",
              `an OAuth client secret, posted to ${prefix + suffix}'s host`,
            );
        }
        const known = TOKEN_HOSTS.find(([pattern]) => pattern.test(upper));
        if (known)
          return secretRow(
            key,
            { hosts: known[1], headers: null },
            "table",
            `an OAuth client secret, posted to ${known[2]}`,
          );
      }
      const shape = SHAPES.find(([pattern]) => pattern.test(value));
      if (shape)
        return shape[1] === "value"
          ? { key, kind: "value", by: "value", why: shape[2], warnings: [] }
          : secretRow(key, shape[1], "value", shape[2]);
      const named = NAMES.find(([pattern]) => pattern.test(upper));
      if (named)
        return named[1] === "value" || named[1] === "local"
          ? { key, kind: named[1], by: "table", why: named[2], warnings: [] }
          : secretRow(key, named[1], "table", `${named[2]}, by its name`);
      if (NOT_SECRET.test(upper))
        return { key, kind: "value", by: "name", why: "not a secret, by its name", warnings: [] };
      if (SECRETISH.test(upper))
        return {
          key,
          kind: "ask",
          by: "name",
          why: "looks like a secret, but where it goes is not known",
          warnings: [],
        };
      return { key, kind: "value", by: "name", why: "not a secret, by its name", warnings: [] };
    })();
    // Warnings, from the value (never shown).
    if (row.kind === "secret") {
      if (/[\r\n]/.test(value)) {
        rows.push({
          key,
          kind: "local",
          by: row.by,
          why: "it is more than one line; a secret's value is one line",
          warnings: [],
        });
        continue;
      }
      if (row.headers === null && /[+/=&% #?]/.test(value))
        row.warnings.push(
          "its value has a character a form body or a URL would need encoded (+ / = & % space # ?), and the proxy puts it in place as it is: if it is sent that way, give it in a header instead",
        );
      if (row.by === "token url" || (row.by === "table" && /CLIENT_SECRET$/.test(upper)))
        row.warnings.push(
          "only if the app posts it in the request body (client_secret_post); in HTTP Basic auth it is base64-encoded, and the proxy cannot find the name",
        );
    }
    if (entry.spaced)
      row.warnings.push(`written with a space around "=": dotenv reads it, some parsers do not`);
    rows.push(row);
  }
  return rows;
};

declare namespace planEnv {
  /** the owner's .env (2026-11-18), with made-up values of the right shapes */
  export type Owners = Expect<
    Invoke<
      typeof planEnv,
      [
        lines: [
          {
            kind: "entry";
            key: "OPENAI_API_KEY";
            value: "sk-proj-abcdefghijklmnopqrstuvwxyz";
            exported: false;
            quote: "";
            spaced: false;
            raw: "";
          },
          {
            kind: "entry";
            key: "JWT_SECRET_KEY";
            value: "x";
            exported: false;
            quote: "";
            spaced: false;
            raw: "";
          },
          {
            kind: "entry";
            key: "JWT_ALGORITHM";
            value: "HS256";
            exported: false;
            quote: "";
            spaced: false;
            raw: "";
          },
          {
            kind: "entry";
            key: "LIVEBLOCKS_PUBLIC_KEY";
            value: "pk_dev_abc";
            exported: false;
            quote: "";
            spaced: false;
            raw: "";
          },
          {
            kind: "entry";
            key: "MIT_CLIENT_SECRET";
            value: "abc-DEF_123";
            exported: false;
            quote: "";
            spaced: false;
            raw: "";
          },
          {
            kind: "entry";
            key: "MIT_TOKEN_URL";
            value: "https://okta.mit.edu/oauth2/v1/token";
            exported: false;
            quote: "";
            spaced: false;
            raw: "";
          },
          {
            kind: "entry";
            key: "MICROSOFT_CLIENT_SECRET";
            value: "abc~DEF.123";
            exported: false;
            quote: "";
            spaced: false;
            raw: "";
          },
          {
            kind: "entry";
            key: "AWS_SECRET_ACCESS_KEY";
            value: "abc/def+ghi";
            exported: false;
            quote: "";
            spaced: false;
            raw: "";
          },
          {
            kind: "entry";
            key: "CLAUDE_API_KEY";
            value: "sk-ant-api03-abc";
            exported: false;
            quote: "";
            spaced: true;
            raw: "";
          },
          {
            kind: "entry";
            key: "DESMOS_API_KEY";
            value: "dcb31709b452b1cf9dc26972add0fda6";
            exported: false;
            quote: "";
            spaced: false;
            raw: "";
          },
          {
            kind: "entry";
            key: "MYSTERY_TOKEN";
            value: "zzz";
            exported: false;
            quote: "";
            spaced: false;
            raw: "";
          },
        ],
      ]
    >,
    "=",
    [
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
        key: "JWT_SECRET_KEY";
        kind: "local";
        by: "table";
        why: "this app signs with it: use a dev-only value";
        warnings: [];
      },
      {
        key: "JWT_ALGORITHM";
        kind: "value";
        by: "name";
        why: "not a secret, by its name";
        warnings: [];
      },
      {
        key: "LIVEBLOCKS_PUBLIC_KEY";
        kind: "value";
        by: "value";
        why: "a publishable key (pk_): meant for the browser";
        warnings: [];
      },
      {
        key: "MIT_CLIENT_SECRET";
        kind: "secret";
        name: "MIT-CLIENT-SECRET";
        hosts: ["okta.mit.edu"];
        headers: null;
        by: "token url";
        why: "an OAuth client secret, posted to MIT_TOKEN_URL's host";
        warnings: [
          "only if the app posts it in the request body (client_secret_post); in HTTP Basic auth it is base64-encoded, and the proxy cannot find the name",
        ];
      },
      {
        key: "MIT_TOKEN_URL";
        kind: "value";
        by: "name";
        why: "not a secret, by its name";
        warnings: [];
      },
      {
        key: "MICROSOFT_CLIENT_SECRET";
        kind: "secret";
        name: "MICROSOFT-CLIENT-SECRET";
        hosts: ["login.microsoftonline.com"];
        headers: null;
        by: "table";
        why: "an OAuth client secret, posted to Microsoft's token endpoint";
        warnings: [
          "only if the app posts it in the request body (client_secret_post); in HTTP Basic auth it is base64-encoded, and the proxy cannot find the name",
        ];
      },
      {
        key: "AWS_SECRET_ACCESS_KEY";
        kind: "local";
        by: "table";
        why: "AWS signs each request with it on this side: it is never sent";
        warnings: [];
      },
      {
        key: "CLAUDE_API_KEY";
        kind: "secret";
        name: "CLAUDE-API-KEY";
        hosts: ["api.anthropic.com"];
        headers: ["x-api-key", "authorization"];
        by: "value";
        why: "an Anthropic key (sk-ant-)";
        warnings: ['written with a space around "=": dotenv reads it, some parsers do not'];
      },
      {
        key: "DESMOS_API_KEY";
        kind: "value";
        by: "table";
        why: "the browser loads Desmos with it, on your Mac, outside the proxy (a public key, limited by domain)";
        warnings: [];
      },
      {
        key: "MYSTERY_TOKEN";
        kind: "ask";
        by: "name";
        why: "looks like a secret, but where it goes is not known";
        warnings: [];
      },
    ]
  >;
  /** what the person chose before comes first; a value that a body would need encoded is said */
  export type Remembered = Expect<
    Invoke<
      typeof planEnv,
      [
        lines: [
          {
            kind: "entry";
            key: "MYSTERY_TOKEN";
            value: "a+b/c=";
            exported: false;
            quote: "";
            spaced: false;
            raw: "";
          },
        ],
        remembered: {
          MYSTERY_TOKEN: { kind: "secret"; hosts: ["api.mystery.example"]; headers: null };
        },
      ]
    >,
    "=",
    [
      {
        key: "MYSTERY_TOKEN";
        kind: "secret";
        name: "MYSTERY-TOKEN";
        hosts: ["api.mystery.example"];
        headers: null;
        by: "remembered";
        why: "as you chose before";
        warnings: [
          "its value has a character a form body or a URL would need encoded (+ / = & % space # ?), and the proxy puts it in place as it is: if it is sent that way, give it in a header instead",
        ];
      },
    ]
  >;
}

/** The .env again, each secret's value replaced by its name, everything else as it was.
 *  `secrets`: key -> name. */
export const rewriteEnv = (lines: EnvLine[], secrets: Record<string, string>): string =>
  lines
    .map((line) => {
      if (line.kind !== "entry" || !Object.hasOwn(secrets, line.key)) return line.raw;
      const name = secrets[line.key]!;
      return `${line.exported ? "export " : ""}${line.key}=${line.quote}${name}${line.quote}`;
    })
    .join("\n");

declare namespace rewriteEnv {
  /** the secret's value becomes its name; the rest is untouched, comments and all */
  export type Rewritten = Expect<
    Invoke<
      typeof rewriteEnv,
      [
        lines: [
          { kind: "other"; raw: "# keys" },
          {
            kind: "entry";
            key: "OPENAI_API_KEY";
            value: "sk-x";
            exported: true;
            quote: '"';
            spaced: false;
            raw: 'export OPENAI_API_KEY="sk-x"';
          },
          {
            kind: "entry";
            key: "PORT";
            value: "3000";
            exported: false;
            quote: "";
            spaced: false;
            raw: "PORT=3000";
          },
          { kind: "other"; raw: "" },
        ],
        secrets: { OPENAI_API_KEY: "OPENAI-API-KEY" },
      ]
    >,
    "=",
    '# keys\nexport OPENAI_API_KEY="OPENAI-API-KEY"\nPORT=3000\n'
  >;
}
