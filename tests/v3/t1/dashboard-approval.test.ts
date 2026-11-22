// T1. The approval page's address the dashboard opens (release/root/ui/dashboard.js,
// approvalUrl): its bare `/`, the only address another site may open (host/approve-web.ts),
// and for the push Push started, a fragment naming it for the page to mark. A fragment never
// reaches the server, so the same-site rule is unchanged; what the push names is encoded, so a
// branch name cannot add a part of its own.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vm from "node:vm";

const SOURCE = path.resolve(import.meta.dirname, "../../../release/root/ui/dashboard.js");

/** Anything the script touches as it loads (the document, storage, the stream): a stand-in
 *  that answers every use with another, so only what it defines is exercised. */
const anything: unknown = new Proxy(function () {}, {
  get: (_, key) =>
    key === Symbol.iterator
      ? [][Symbol.iterator]
      : key === Symbol.toPrimitive
        ? () => ""
        : anything,
  apply: () => anything,
  construct: () => anything as object,
});

const load = () => {
  const context: Record<string, unknown> = {
    document: anything,
    window: { desolateKey: { headers: {}, query: "" } },
    localStorage: anything,
    location: { search: "", pathname: "/" },
    history: anything,
    matchMedia: anything,
    EventSource: anything,
    fetch: () => new Promise(() => {}),
    URLSearchParams,
    setTimeout,
    console,
  };
  vm.runInNewContext(
    `${fs.readFileSync(SOURCE, "utf8")}\nthis.approvalUrl = approvalUrl; this.setState = (s) => { state = s; };`,
    context,
  );
  return context as {
    approvalUrl: (push?: { repo: string; branch: string; commit: string }) => string | null;
    setState: (s: unknown) => void;
  };
};

describe("T1 the approval page's address, as the dashboard opens it", () => {
  const page = load();
  page.setState({
    stack: { approveHostname: "desolate-approve.localhost", editorPort: 41581 },
  });
  const commit = "0123456789abcdef0123456789abcdef01234567";

  it("is the bare address, with no push named (the control)", () => {
    assert.equal(page.approvalUrl(), "http://desolate-approve.localhost:41581/");
  });

  it("names the push Push started in a fragment only: the path and query stay bare", () => {
    const url = new URL(page.approvalUrl({ repo: "acme/app", branch: "feature/login", commit })!);
    assert.equal(url.pathname, "/");
    assert.equal(url.search, "");
    assert.equal(url.hash, `#repo=acme%2Fapp&branch=feature%2Flogin&commit=${commit}`);
    const named = new URLSearchParams(url.hash.slice(1));
    assert.deepEqual(
      [named.get("repo"), named.get("branch"), named.get("commit")],
      ["acme/app", "feature/login", commit],
    );
  });

  it("encodes what a push names, so a name cannot add a part or a query", () => {
    const url = new URL(
      page.approvalUrl({ repo: "acme/app", branch: "x&commit=f00?tkn=1#y", commit })!,
    );
    assert.equal(url.search, "");
    const named = new URLSearchParams(url.hash.slice(1));
    assert.deepEqual([...named.keys()], ["repo", "branch", "commit"]);
    assert.equal(named.get("branch"), "x&commit=f00?tkn=1#y");
    assert.equal(named.get("commit"), commit);
  });

  it("is none before the host has said where the page is", () => {
    page.setState({ stack: null });
    assert.equal(page.approvalUrl({ repo: "acme/app", branch: "fix", commit }), null);
  });
});
