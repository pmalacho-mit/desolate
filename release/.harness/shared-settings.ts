// Harness for the in-source tests of shared/settings.ts: what `desolate settings` does with
// the registry, as far as a test needs it. A setting holds functions (its parser, perhaps its
// default), which a test cannot compare; its name it can.

/** The names of `settings`, in their order. */
export const namesOf = (settings: readonly { name: string }[]): string[] =>
  settings.map((setting) => setting.name);
