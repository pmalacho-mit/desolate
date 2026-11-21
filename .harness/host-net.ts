// Harness for in-source tests of `desolate domain <d> net recommend` (host/domains.ts): a
// root that reached many hosts, and what the printed report says of them. With host-stack.ts:
// its rootAnswers is what these answer through.
import { rootAnswers } from "./host-stack.ts";

/** The root's answer to net.recommend, for a domain on the open network that reached
 *  `count` hosts its list does not name (h1.example most, then h2.example and on), and was
 *  refused none: every one, with the count. */
export const reachedHosts = (count: number) => {
  const items = Array.from({ length: count }, (_, i) => ({
    host: `h${i + 1}.example`,
    count: count - i,
  }));
  rootAnswers({
    "net.recommend": {
      mode: "open",
      listed: [],
      reached: { items, total: count, from: 0 },
      refused: { items: [], total: 0, from: 0 },
    },
  });
};

/** What a printed report says of its hosts: how many it listed, the hosts its `net allow`
 *  command names, and whether a line before that command says they are not all. */
export const reportOf = (lines: string[]) => {
  const allow = lines.findIndex((line) => / net allow /.test(line));
  return {
    listed: lines.filter((line) => /^\s+\d+\s+h\d+\.example$/.test(line)).length,
    more: lines.find((line) => /^\s+and \d+ more/.test(line))?.trim() ?? null,
    allows: allow < 0 ? 0 : lines[allow]!.split(" net allow ")[1]!.split(" ").length,
    saidBefore: allow > 0 && /only the \d+ above, of \d+/.test(lines[allow - 1]!),
  };
};
