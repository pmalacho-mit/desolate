// T1. The secrets page's copies of bounds the TypeScript holds (R3): a page cannot import
// them, so each is written again in host/approve-ui/, and this checks they still agree with
// their source. The .env size is host/env-import.ts's ENV_MAX; a secret's name is
// host/envfile.ts's SECRET_NAME_RULE, which the root also writes (root/proxy/secret-store.ts,
// root/proxy/secrets_addon.py).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

process.env.DESOLATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-secrets-page-"));
const { ENV_MAX } = await import("../../../release/host/env-import.ts");
const { ANYWHERE_COST, SECRET_NAME, SECRET_NAME_RULE, secretName } =
  await import("../../../release/host/envfile.ts");

const RELEASE = path.resolve(import.meta.dirname, "../../../release");
const read = (file: string) => fs.readFileSync(path.join(RELEASE, file), "utf8");

describe("T1 the secrets page's bounds are the TypeScript's", () => {
  it("the .env size it refuses past is ENV_MAX", () => {
    const page = read("host/approve-ui/secrets.js");
    const copy = /^const ENV_MAX = (\d+);$/m.exec(page);
    assert.ok(copy, "secrets.js names its copy ENV_MAX");
    assert.equal(Number(copy[1]), ENV_MAX);
    assert.match(page, /file\.size > ENV_MAX/, "and refuses by it");
  });

  it("the anywhere box says what it costs, as the CLI's --anywhere does", () => {
    const html = read("host/approve-ui/secrets.html");
    assert.match(html, /<input type="checkbox" name="anywhere">/);
    assert.ok(html.includes(`<span class="hint">${ANYWHERE_COST}</span>`), "the cost beside it");
  });

  it("the name it takes is the root's rule, and its hint says the same numbers", async () => {
    const html = read("host/approve-ui/secrets.html");
    const pattern = /<input name="name" required pattern="([^"]+)"/.exec(html)?.[1];
    assert.ok(pattern, "the name's input has a pattern");
    // A browser's pattern matches the whole value, and in the `v` mode (where `-` is escaped).
    const page = new RegExp(`^(?:${pattern})$`, "v");
    for (const name of [
      "OPENAI-API-KEY",
      "A1234567",
      "A".repeat(64),
      "A".repeat(65),
      "a1234567",
      "1ABCDEFGH",
      "ABC",
      "ABCDEFG",
      "MY_TOKEN-2",
      "MY.TOKEN.2",
    ])
      assert.equal(page.test(name), SECRET_NAME_RULE.test(name), name);
    assert.match(
      html,
      new RegExp(
        `\\(${SECRET_NAME.least} to ${SECRET_NAME.most} of A-Z, 0-9, _ and -, a letter first\\)`,
      ),
    );
    assert.equal(SECRET_NAME_RULE.source, "^[A-Z][A-Z0-9_-]{7,63}$");
    // (The store's own rule, exported since limits 10: compared as the rule it is.)
    const { PLACEHOLDER } = await import("../../../release/root/proxy/secret-store.ts");
    assert.equal(
      PLACEHOLDER.source,
      SECRET_NAME_RULE.source,
      "the root's store takes the same names",
    );
    assert.ok(
      read("root/proxy/secrets_addon.py").includes(
        `SECRET_NAME = re.compile(r"${SECRET_NAME_RULE.source.slice(1, -1)}")`,
      ),
      "and the root's proxy",
    );
  });

  it("every name made from a key is one the rule takes, however long the key", () => {
    for (const key of ["API_KEY", "OPENAI_API_KEY", "_2FA", "X".repeat(300), "a_".repeat(90)])
      assert.match(secretName(key), SECRET_NAME_RULE, key);
    assert.notEqual(secretName(`${"A_".repeat(40)}ONE`), secretName(`${"A_".repeat(40)}TWO`));
  });
});
