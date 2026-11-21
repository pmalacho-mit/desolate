// Harness for the in-source tests of workspace/bridge.ts: a compose service with many
// listeners, more than there are mirrors, summed up so that a test need not list them.
import { portsOf } from "../workspace/bridge.ts";

/** What portsOf makes of a service listening on `listeners` ports, from 2000 up: how many
 *  get a mirror, the first and the last of those, and what it says got none. */
export const mirrorsFor = (listeners: number) => {
  const read = portsOf(Array.from({ length: listeners }, (_, i) => 2000 + i));
  return {
    mirrored: read.ports.length,
    first: read.ports[0],
    last: read.ports.at(-1),
    low: read.low,
    more: read.more,
  };
};
