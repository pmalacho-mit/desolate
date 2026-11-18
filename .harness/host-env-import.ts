// Harness for host/env-import.ts: a secret store that takes what it is given and holds none.
export const quietOps = { set: async () => [], list: async () => [] };
