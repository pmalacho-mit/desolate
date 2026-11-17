// Vitest's setup file for the in-source tests (vitest.config.ts): each test file gets a
// desolate home of its own before it imports anything, since host/paths.ts reads
// DESOLATE_HOME once, when it is first imported. Tests in one file run one after another and
// share that home: a test that needs it empty says so (home.ts's `emptyHome`).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll } from "./vitest.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-nests-"));
process.env.DESOLATE_HOME = home;
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

// And the stack's settings at their defaults: the tests' expectations name the default
// port, and a person running a second stack beside another's sets DESOLATE_EDITOR_PORT in
// their shell (developing-desolate.md), which failed nine of them (2026-11-17).
delete process.env.DESOLATE_EDITOR_PORT;
