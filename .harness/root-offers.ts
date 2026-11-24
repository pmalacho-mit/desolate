// Harness for in-source tests of a domain's offers (root/offers.ts): several processes of the
// root changing them at once, as rootd, the state service, the CLI channel and a push do.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const OFFERS_TS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "root",
  "offers.ts",
);
const NODE = ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e"];

/** 200 offers of the domain `acme`, then `takers` processes at once each withdrawing `each` of
 *  them: through offers.ts (`locked`), or, the control, by reading offers.json and writing it
 *  back with no lock, as every writer did before. They start together (each waits for a
 *  file). Answers how many offers are left: none, when no change was lost. */
export const withdrawnAtOnce = async (takers: number, each: number, locked: boolean) => {
  const file = path.join(process.env.DESOLATE_ROOT_DOMAINS!, "acme", "offers.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const all = Array.from({ length: takers * each }, (_, n) => ({
    domain: "acme",
    repo: "acme/app",
    branch: `b${Math.floor(n / each)}-${n % each}`,
    commit: "0".repeat(40),
    workspace: "",
    lfs: 0,
    at: "",
  }));
  fs.writeFileSync(file, JSON.stringify(all));
  const go = `${file}.go`;
  fs.rmSync(go, { force: true });
  const code = `
    import * as fs from "node:fs";
    import { withdraw } from ${JSON.stringify(OFFERS_TS)};
    const [taker, each, locked, file, go] = JSON.parse(process.argv[1]);
    process.stdout.write("ready\\n");
    while (!fs.existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 5));
    for (let i = 0; i < each; i++) {
      const branch = "b" + taker + "-" + i;
      if (locked) await withdraw("acme", "acme/app", branch);
      else {
        const kept = JSON.parse(fs.readFileSync(file, "utf8")).filter((o) => o.branch !== branch);
        fs.writeFileSync(file + ".tmp" + taker, JSON.stringify(kept));
        fs.renameSync(file + ".tmp" + taker, file);
      }
    }`;
  const started = Array.from({ length: takers }, (_, taker) => {
    const child = spawn(
      process.execPath,
      [...NODE, code, JSON.stringify([taker, each, locked, file, go])],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    return {
      ready: new Promise<void>((resolve) => child.stdout.once("data", () => resolve())),
      ended: new Promise<void>((resolve, reject) =>
        child.on("close", (status) =>
          status === 0 ? resolve() : reject(new Error(`a taker failed (${status}): ${stderr}`)),
        ),
      ),
    };
  });
  await Promise.race([
    Promise.all(started.map((taker) => taker.ready)),
    ...started.map((taker) => taker.ended),
  ]);
  fs.writeFileSync(go, "");
  await Promise.all(started.map((taker) => taker.ended));
  return (JSON.parse(fs.readFileSync(file, "utf8")) as unknown[]).length;
};
