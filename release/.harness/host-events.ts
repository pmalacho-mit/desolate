// Harness for the in-source tests of release/host/events.ts: what a listener of the daemon's
// hub hears, which a type cannot say (a listener is a callback).
import type { hub } from "../host/events.ts";

/** Makes a hub that keeps `keep`, publishes `before`, then listens asking for `replay` of
 *  them, then publishes `after`, then stops listening. The types heard, in order, and whether
 *  the hub had a listener while it listened and after it stopped. */
export const heardFrom = (makeHub: typeof hub, keep: number, before: string[], replay: number, after: string[]) => {
  const h = makeHub(keep);
  for (const type of before) h.publish(h.host(type, {}));
  const heard: string[] = [];
  const stop = h.listen(replay, (line) => void heard.push((JSON.parse(line) as { type: string }).type));
  for (const type of after) h.publish(h.host(type, {}));
  const listening = h.listening();
  stop();
  h.publish(h.host("after-stop", {}));
  return { heard, listening, afterStop: h.listening() };
};
