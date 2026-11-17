// Harness for in-source tests of code that reads an environment variable when it is called
// (DESOLATE_BACKEND, DESOLATE_EDITOR_PORT, ...): it stands in for the person's shell setting
// one, and puts it back as it was when the test ends.
import { onTestFinished } from "./vitest.ts";

/** `name` set to `value`, or unset for null, for the rest of this test. */
export const setEnv = (name: string, value: string | null) => {
  const was = process.env[name];
  onTestFinished(() => {
    if (was === undefined) delete process.env[name];
    else process.env[name] = was;
  });
  if (value === null) delete process.env[name];
  else process.env[name] = value;
};
