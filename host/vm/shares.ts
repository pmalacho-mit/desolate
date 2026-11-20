// What a VM's share may be on the Mac: a real directory, reached through no symlink. The root
// VM shares desolate's domains/ writable, and its ordinary user owns what is in it: it could
// replace a domain's repos/ (or a cache, an outbox, a mirror) with a symlink to any folder of
// the Mac's, and the next workspace started would mount that folder, writable, in a VM where
// anything may run (audit, 2026-11-20). Lima resolves a share's location at every start, so
// this is asked before a VM is made and before every start. (The time between this and
// Lima's own look is not closed here: see docs/v3/decisions.md, "Shares the root can rename".)
import * as fs from "node:fs";
import * as path from "node:path";

/** Why `host` may not be shared (a symlink on its way from `home`, or a path that is not
 *  where it says), or null. Shares outside `home` (the release, read-only) are not asked. */
export const shareRefused = (host: string, home: string): string | null => {
  const root = path.resolve(home);
  const target = path.resolve(host);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  let at = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(at);
    } catch {
      return null; // not there yet: made by desolate itself, as a directory, below
    }
    if (stat.isSymbolicLink()) return `${at} is a symlink`;
    if (!stat.isDirectory()) return `${at} is not a directory`;
  }
  const real = fs.realpathSync(target);
  return real === path.join(fs.realpathSync(root), path.relative(root, target))
    ? null
    : `${target} is really ${real}`;
};
