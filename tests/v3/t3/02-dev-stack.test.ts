// T4 (vz, on a Mac: DESOLATE_TIER=T4). Not a boundary: a project's dev stack
// as it runs in a workspace, on a real VM, so the conveniences around the boundary are tried
// with what real use sends. Found 2026-11-18, by an agent setting up a project: a backend
// container behind its dev server's proxy, Postgres beside it, and API keys as secrets.
// None of it had been tried in a real VM, and two of the three failed there.
//
// The containers run on the workspace VM's own Docker, which is what a devcontainer with the
// `docker-outside-of-docker` feature talks to; such a devcontainer is on the VM's network
// (`--network=host`), so what the VM reaches is what it reaches. No devcontainer is built
// here: that is minutes of image and features that test nothing more about the network.
//
// Needs Docker Hub from the VM (python:3.12-slim, postgres:16-alpine), through the domain's
// proxy, as a person's devcontainer would pull them.
//
// Run: tests/v3/run.sh t4
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { vmStatus } from "../../../release/host/vm/lima.ts";
import { bootstrap, git, newStack, REPO_ROOT } from "../lib/harness.ts";
import type { Stack } from "../lib/harness.ts";

let stack: Stack;
const REAL = process.env.DESOLATE_TIER === "T4";
const PORT = 18431; // a backend's published port: not one a Mac is likely to hold
const PY = "python:3.12-slim";
const PG = "postgres:16-alpine";
let vm = "";
const asRoot = (script: string) => stack.inVm(vm, ["bash", "-c", script], { root: true });

/** One HTTP GET to the forwarder on the Mac's loopback, by the workspace's own name, as a
 *  browser on the Mac sends it. */
const fromTheMac = (url: URL): Promise<string> =>
  new Promise((resolve) => {
    const socket = net.connect(Number(url.port), "127.0.0.1");
    let data = "";
    socket.setTimeout(60_000, () => socket.destroy());
    socket.on("connect", () =>
      socket.write(`GET / HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`),
    );
    socket.on("data", (chunk) => (data += chunk));
    socket.on("close", () => resolve(data));
    socket.on("error", () => resolve(data || "ERROR"));
  });

describe(
  "T3: a project's dev stack in a workspace, on a real VM",
  { skip: REAL ? false : "set DESOLATE_TIER=T4 (tests/v3/run.sh t4, on a Mac)" },
  () => {
    before(() => {
      stack = newStack("dev");
      stack.seed("acme/app", (dir) => {
        fs.writeFileSync(path.join(dir, "README.md"), "# app\n");
        git(dir, "add", "-A");
        git(dir, "commit", "--quiet", "-m", "seed");
      });
    });
    after(() => stack?.destroy());

    it("T3 bootstrap, a domain, and a workspace", () => {
      stack.step(`bootstrap on the ${stack.backend} backend`);
      const result = bootstrap(stack);
      assert.equal(result.code, 0, result.stderr + result.stdout.slice(-1500));
      stack.step("clone, domain, workspace");
      assert.equal(stack.desolate("clone", "acme/app", "--no-domain").code, 0);
      assert.equal(stack.desolate("domain", "create", "dev").code, 0);
      assert.equal(stack.desolate("domain", "dev", "add", "--repo", "acme/app").code, 0);
      const up = stack.desolate("up", "dev");
      assert.equal(up.code, 0, up.stderr);
      const list = JSON.parse(stack.quiet("list", "--json").stdout) as {
        domain: string;
        workspaces: { workspace: string; vm: string }[];
      }[];
      vm = list.find((d) => d.domain === "dev")!.workspaces[0]!.vm;
      // The images, pulled through the domain's proxy as a devcontainer's would be.
      const pulled = asRoot(`docker pull -q ${PY} && docker pull -q ${PG}`);
      assert.equal(pulled.code, 0, pulled.stderr + pulled.stdout);
    });

    it("T3 a backend container's port 80, published: reached from the VM, by another container, and from the Mac", async () => {
      stack.step("a backend container behind a published port");
      const started = asRoot(`docker network create devnet >/dev/null
docker run -d --name backend --network devnet -p ${PORT}:80 ${PY} sh -c 'mkdir -p /www && echo backend-answered > /www/index.html && cd /www && exec python -m http.server 80' >/dev/null
for i in $(seq 60); do docker exec backend python -c "import urllib.request as u; u.urlopen('http://127.0.0.1/')" >/dev/null 2>&1 && break; sleep 1; done; echo started`);
      assert.match(started.stdout, /started/, started.stderr);
      // What a devcontainer on the VM's network sends, and what its dev server's proxy
      // sends: the published port, by address and by name. docker-proxy carries it to the
      // container's own address, on port 80.
      const fromVm = asRoot(`echo "address=$(curl -s -m 10 http://127.0.0.1:${PORT}/)"
echo "localhost=$(curl -s -m 10 http://localhost:${PORT}/)"
echo "by_name=$(docker run --rm --network devnet ${PY} python -c "import urllib.request as u; print(u.urlopen('http://backend/', timeout=10).read().decode().strip())" 2>&1 | tail -1)"
echo "placeholder=$(curl -s -m 10 http://198.18.0.1/)"`);
      const got = Object.fromEntries(
        fromVm.stdout
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
      assert.equal(got.address, "backend-answered", fromVm.stdout);
      assert.equal(got.localhost, "backend-answered");
      assert.equal(got.by_name, "backend-answered", "a compose service calling another on 80");
      assert.equal(
        got.placeholder,
        "desolate: a destination is a hostname: an address alone is not carried",
        "control: port 80 to an address that is not the VM's own still goes to the relay",
      );
      // From the Mac, at the workspace's own name, through the forwarder: as a browser opens
      // it. The port is forwarded once the workspace's daemon has seen docker-proxy listen.
      let url: URL | null = null;
      for (let i = 0; i < 40 && !url; i++) {
        const ports = JSON.parse(stack.quiet("ports", "--json").stdout) as {
          forwarded: { url: string }[];
        }[];
        const found = ports
          .flatMap((w) => w.forwarded)
          .find((f) => new URL(f.url).port === String(PORT));
        if (found) url = new URL(found.url);
        else await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      assert.ok(url, "the published port is forwarded to the Mac");
      const page = await fromTheMac(url);
      assert.match(page, /^HTTP\/1\.[01] 200 /, page.slice(0, 300));
      assert.match(page, /backend-answered/);
    });

    it("T3 Postgres with its data in a named volume, on the VM's disk, answers a client by name", () => {
      stack.step("Postgres in a named volume");
      // Not a bind mount of /workspaces: on a Mac that is virtiofs, which does not keep the
      // owner initdb sets (reference.md, "Containers a dev stack starts"). The named volume
      // is what the reference says to use, so it is what is checked.
      const db =
        asRoot(`docker run -d --name db --network devnet -e POSTGRES_PASSWORD=pw -v devdb:/var/lib/postgresql/data ${PG} >/dev/null
for i in $(seq 90); do docker exec db pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker run --rm --network devnet -e PGPASSWORD=pw ${PG} psql -h db -U postgres -Atc 'select 40 + 2' 2>&1 | tail -1
docker inspect -f '{{range .Mounts}}{{.Type}} {{.Source}}{{end}}' db`);
      const [answer, mount] = db.stdout.trim().split("\n").slice(-2);
      assert.equal(answer, "42", db.stdout + db.stderr);
      assert.match(
        mount ?? "",
        /^volume \/var\/lib\/docker\/volumes\/devdb\//,
        "on the VM's own disk",
      );
    });

    it("T3 a container calling a secret's host: substituted once it trusts the domain's CA, as the reference says", () => {
      stack.step("a secret, from a container");
      const forge = stack.env.DESOLATE_FORGE_SPEC!.replace(/^.*@/, "").replace(/:\d+$/, "");
      const crt = fs.readFileSync(path.join(stack.work, "forge-state", "upstream.crt"), "utf8");
      const root = stack.inRoot(
        [
          "bash",
          "-c",
          `printf '%s api.example.test\\n' ${forge} >> /etc/hosts && cat > /usr/local/share/ca-certificates/test-upstream.crt && update-ca-certificates >/dev/null 2>&1`,
        ],
        { root: true, input: crt },
      );
      assert.equal(root.code, 0, root.stderr);
      assert.equal(stack.quiet("domain", "dev", "net", "allow-internal", forge).code, 0);
      const set = spawnSync(
        path.join(REPO_ROOT, "release", "cli.sh"),
        [
          "domain",
          "dev",
          "secret",
          "set",
          "DEV-STACK-KEY",
          "--hosts",
          "api.example.test",
          "--headers",
          "authorization",
        ],
        { env: stack.env, input: "dev-stack-value-73\n", encoding: "utf8" },
      );
      assert.equal(set.status, 0, set.stderr);
      // Python's own TLS (urllib: the image's store; httpx and requests: certifi) does not
      // know the domain's CA. The reference's compose lines: the VM's store, as a folder, and
      // SSL_CERT_FILE pointing into it.
      const call = (where: string, mount: string) =>
        `docker run --rm ${mount} ${PY} python -c "
import urllib.request as u
q = u.Request('https://api.example.test/${where}', headers={'Authorization': 'Bearer DEV-STACK-KEY'})
try:
    print(u.urlopen(q, timeout=60).read().decode().strip())
except Exception as e:
    print('ERROR', e)
" 2>&1 | tail -1`;
      const sent = asRoot(`echo "own_store=$(${call("own-store", "")})"
echo "vm_store=$(${call("vm-store", "-v /etc/ssl/certs:/desolate-certs:ro -e SSL_CERT_FILE=/desolate-certs/ca-certificates.crt")})"`);
      assert.match(
        sent.stdout,
        /^own_store=ERROR .*CERTIFICATE_VERIFY_FAILED/m,
        "control: with its own store, the container does not trust the domain's CA",
      );
      assert.match(
        sent.stdout,
        /^vm_store=upstream https host=api\.example\.test path=\/vm-store$/m,
        sent.stdout,
      );
      const seen = (
        JSON.parse(stack.forge("upstream")) as { path: string; authorization: string | null }[]
      ).filter((entry) => entry.path === "/vm-store" || entry.path === "/own-store");
      assert.deepEqual(
        seen.map((entry) => [entry.path, entry.authorization]),
        [["/vm-store", "Bearer dev-stack-value-73"]],
        "the upstream received the value, and only from the container that trusted the CA",
      );
    });

    it("T3 resize: a stopped workspace's VM gets its new CPUs, memory and disk, and keeps what is on its disk", async () => {
      stack.step("resize, in a real VM");
      const running = stack.desolate("resize", "dev/w1", "--cpus", "2");
      assert.notEqual(running.code, 0, "control: refused while it runs");
      assert.match(running.stderr, /a VM's size changes only while it is stopped/);
      assert.equal(stack.quiet("stop", "dev/w1").code, 0);
      // A VM's status as desolate reads it from Lima's pid files and its host agent's socket
      // (lima.ts, vmStatus) is what `limactl list` says, for this one, stopped, and the root
      // VM, running.
      for (const [name, expected] of [
        [vm, "stopped"],
        [`dsl-${stack.instance}-root`, "running"],
      ] as const) {
        const listed = spawnSync(
          process.env.DESOLATE_LIMACTL ?? "limactl",
          ["--tty=false", "list", "--format", "{{.Status}}", name],
          { env: stack.env, encoding: "utf8" },
        );
        assert.equal(listed.status, 0, listed.stderr);
        const said = listed.stdout.trim();
        assert.equal(
          said === "Running" ? "running" : said === "" ? "missing" : "stopped",
          expected,
        );
        assert.equal(
          await vmStatus(path.join(stack.home, "lima", name)),
          expected,
          `${name}: limactl list said ${said}`,
        );
      }
      // Sessions are ssh with Lima's ssh.config for the VM (lima.ts, sessionArgs), which sends
      // a variable of this Mac's only where SendEnv names one: Lima's names none.
      const config = fs.readFileSync(
        path.join(stack.home, "lima", `dsl-${stack.instance}-root`, "ssh.config"),
        "utf8",
      );
      assert.match(config, /^\s*Host lima-/m, "control: Lima's ssh.config, read");
      assert.doesNotMatch(config, /SendEnv|SetEnv/i, config);
      const resized = stack.desolate(
        "resize",
        "dev/w1",
        "--cpus",
        "2",
        "--memory",
        "3g",
        "--disk",
        "36g",
      );
      assert.equal(resized.code, 0, resized.stderr);
      assert.equal(stack.quiet("start", "dev/w1").code, 0);
      const seen = asRoot(`echo "cpus=$(nproc)"
echo "mem_kib=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
echo "disk_gib=$(df -BG --output=size / | tail -1 | tr -dc 0-9)"
echo "volume=$(docker volume ls -q --filter name=^devdb$)"`);
      const got = Object.fromEntries(
        seen.stdout
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
      assert.equal(got.cpus, "2", seen.stdout);
      // MemTotal is what the kernel has after its own reservations: a little under 3 GiB.
      assert.ok(
        Number(got.mem_kib) > 2.6 * 1048576 && Number(got.mem_kib) <= 3 * 1048576,
        `MemTotal ${got.mem_kib} KiB, for 3 GiB`,
      );
      assert.ok(Number(got.disk_gib) >= 34, `the root filesystem grew: ${got.disk_gib}G`);
      assert.equal(got.volume, "devdb", "the named volume, on its disk, is still there");
    });

    it("T3 destroy leaves nothing of this stack", () => {
      stack.step("destroy");
      const result = stack.desolate("destroy", "--all");
      assert.equal(result.code, 0, result.stdout);
      assert.equal(fs.existsSync(stack.home), false);
    });

    it("the transcript reads as reviewed", () => {
      stack.checkTranscript(`${stack.tier.toLowerCase()}-02-dev-stack`);
    });
  },
);
