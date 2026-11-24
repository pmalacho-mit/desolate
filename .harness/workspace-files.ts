// Harness for in-source tests of workspace code that looks at a checkout's files: what is too
// long to write out in a test. (A checkout with files in it is the DSL's TempDir.)

/** A devcontainer spec whose customizations.vscode.settings are exactly `bytes` bytes as
 *  JSON: one setting, with a value as long as that takes. */
export const specWithSettingsOf = (bytes: number): Record<string, unknown> => ({
  customizations: { vscode: { settings: { x: "y".repeat(bytes - '{"x":""}'.length) } } },
});
