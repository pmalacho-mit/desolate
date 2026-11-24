# desolate v3: decisions, and the evidence for each

move-to-vms.md asks the implementing agent to decide its open questions "by research and
measurement", recording the evidence and the choice here. Each entry says what was decided,
what it rests on, and how sure that is. **Measured** means a probe or test in this repository
produced the number; **read** means documentation or other projects; **unverified** means
neither, and the entry says what would settle it.

Measurements on the owner's Mac are in `docs/v3/phase0/` (M1, 64 GiB, macOS 14.5, Lima 2.1.2,
2026-11-10). Everything else was measured in the agent's cloud sandbox: x86_64, no `/dev/kvm`,
QEMU 8.2.2 under TCG, Docker 29.9, Lima 2.3.0.

## Question 15. The VM substrate: Lima/vz (provisional, measured for Lima only)

**Decision:** Lima with `vmType: vz` on a Mac; Lima with QEMU on Linux for the `qemu` backend.

Measured on the M1 (`tests/probes/v3/phase0-mac.sh`):

| | Lima/vz |
|---|---|
| create + first boot, image cached | 16.5 s |
| boot of a stopped VM, to SSH ready | 9.3 to 10.5 s |
| `limactl clone` of a stopped VM | 0.0 s, 0 MB consumed (APFS copy-on-write) |
| a clone's first boot | 9.3 s |
| idle guest memory (2 GiB VM) | 232 MB used; the host process holds 1 to 2 GiB resident |
| disk per VM | 2.2 GB actual for a 20 GB sparse disk |
| suspend to disk | **none**: `limactl snapshot` is unimplemented for vz |

Not measured: Apple Container and microsandbox were not installed on the Mac, so the
"comparison" the spec asks for has one column. Read, not measured: Apple Container's default
network is open and its custom networks need macOS 26 (the Mac is on 14.5), which rules it out
for now on this machine; microsandbox boots OCI images as the VM, which is shape B, not the
decided shape A.

Template to workspace (`phase0-mac-backend.sh`, `docs/v3/phase0/mac-m1-backend-2026-11-11.md`):
a template VM with dockerd and one built devcontainer (image + node feature: 136 s to make,
5.3 GB) was cloned **with a different set of twelve shares** (`limactl clone --set
'.mounts = [...]'`, 0.1 s), booted (9.7 s), its dockerd answered (0.3 s) and
`devcontainer up` found nothing to build (0.7 s): **11.0 s from clone to a running
devcontainer.** The template's shares were gone from the clone and the new ones present,
ten of them read-only and nested under one parent.

Consequences for section 4.7's targets:
- **A new workspace from a template in 15 s: within reach.** 11.0 s measured to a running
  devcontainer, leaving 4 s for the editor server, which was not in that measurement.
- **Resume in 5 s: not met on Lima/vz.** There is no suspend; a stopped VM takes 9.5 s. Either
  the target becomes "about 10 s", or workspaces are paused rather than stopped (SIGSTOP of
  the host process froze and thawed a VM cleanly in the probe, but frees no memory).

## Question 5. Storage on the Mac's disk, shared by virtiofs: yes (measured)

- **Read-only is enforced by the host.** As root in a VM: creating a file in a read-only share
  fails; `mount -o remount,rw` is accepted by the guest kernel and the write then fails with
  "Operation not permitted"; mounting the share's virtiofs tag afresh gives no write either.
  Control: the same writes through the writable share's tag succeed.
- Alternates and `lfs.url=file://` work through the read-only share: a `git clone --shared` had
  0 objects of its own, a 200 KB LFS object smudged with the right sha256, `git fetch origin`
  worked, and a push into the mirror was refused.
- Files appear in a VM owned by the Mac user's uid (501), and Lima's guest user has that uid.

## Question 6. One domain `.git` over virtiofs, written by several VMs: safe enough (measured)

Two VMs, one `.git`, each making 500 commits in its own worktree with a worktree added and
removed every 25 commits: 11.7 s, 1,000 commits present, `git fsck --full --strict` clean from
both. One operation of the 1,040 failed in one VM: `fatal: failed to read
.git/worktrees/ws1-t425/commondir`. That is one VM's git listing worktrees while the other VM
was halfway through creating or removing one, and reading the half-made entry. So: no
corruption, and the one hazard seen is a worktree being added or removed while another VM
runs a command that walks the worktree list. desolate makes worktrees only under a directory
lock that every workspace's init takes, sets `gc.auto=0` in every domain clone, and does not
remove worktrees while a domain has workspaces running. An agent that adds and removes
worktrees of its own in a loop can still make a neighbour's command fail once; the neighbour
retries.

## Question 14. Where checkouts live: on the share (measured)

`npm ci` of a 187-package project (5,180 files, 109 MB), warm cache: 2.0 s on the VM's disk,
3.1 s on the virtiofs share. Walking the tree is 20x slower on the share (0.18 s against
0.009 s) and removing it 16x (0.98 s against 0.06 s), but in absolute terms these are a second.
The proposal stands: checkouts on the share, where the root and other workspaces of the domain
can see them. Revisit for a tree of 100,000 files; the escape hatch is section 4.7's third
option (dependency and build directories on VM-local volumes).

## Section 4.3. The network link: no route out, enforced outside the VM (partly measured)

**Decision:** a workspace's only way out is a stream to its own proxy, and what cuts every
other path is on the host, per backend:

| backend | what cuts egress, outside the VM | the link to the proxy | status |
|---|---|---|---|
| `fake` | `--network none` | a unix socket, bind-mounted | T2 only: not a boundary |
| `qemu` | QEMU's user network with `restrict=on` | `guestfwd` to the host's socket | see T3 |
| `vz` | Lima's host process under `sandbox-exec` | one loopback port on the Mac | measured, ICMP included (Lima 2.3.0) |

Why this shape. Lima always attaches its user-mode network, and offers no setting that
removes it or filters it (read: Lima's network docs; `networkOpts.hostLoopback: false`, new in
2.3, closes only the Mac's loopback). But on vz that network is a user-space stack inside
Lima's own host process, so every connection a guest makes is a socket that process opens.
Confine the process and the guest is confined, by the Mac's kernel, whatever root in the
guest does. devvm's documentation describes the same idea ("runs on its confined process",
re-checked at every launch).

Measured on the M1 (`phase0-mac-egress.sh`): with the host process under a profile that
allows one loopback port, the guest reached that port and was refused another loopback port,
the internet by name and by address, and the LAN router over TCP; root in the guest, after
rewriting routes and flushing every firewall rule, was refused too. The control (the same VM
started without the sandbox) reached all of them.

Round 2 (`phase0-mac-egress2.sh`, `docs/v3/phase0/mac-m1-egress2-2026-11-11.txt`) took the
three gaps round 1 found:

1. **Closed.** With the VM's forwarded ssh port also allowed, `limactl start` under the
   sandbox exits 0 in 8.4 s. (That port leads only to the guest's own sshd.)
2. **Closed for the system resolver.** With the profile also denying the Mac resolver's
   socket (`/var/run/mDNSResponder`), `getent hosts example.com` in the guest fails, where
   under the profile without that line it resolved. So the profile is: one proxy port, the
   ssh port, unix sockets except the resolver's.
3. **ICMP: closed (round 3, Lima 2.3.0).** Round 2 (Lima 2.1.2) saw a confined guest's
   ping to 1.1.1.1 and to the LAN router answered under all four profiles, and could not
   tell whether the echoes left the Mac. Round 3 (`phase0-mac-egress3.sh`,
   `docs/v3/phase0/mac-m1-egress3-2026-11-11.md`) pinged documentation addresses as well:

   | | 1.1.1.1 | 192.0.2.1, 203.0.113.77 |
   |---|---|---|
   | the Mac itself | answered, 27.7 ms | no reply |
   | guest, host process unconfined (control) | answered, 20.0 ms | no reply |
   | guest, host process under the workspace profile | **no reply** | no reply |

   So on 2.3.0 Lima's user-mode stack does **not** answer echoes itself: an unconfined
   guest's ping really leaves the Mac (a channel, if it were allowed), and the profile's
   `(deny network-outbound)` stops it, as it stops TCP and UDP. Why 2.1.2 differed is not
   known (it may have answered locally, or its ICMP path may have escaped the profile), so
   the vz backend requires Lima 2.3.0 or newer (`doctor` fails older), and tier T4's
   boundary test pings from root in a workspace with the root VM's ping as the control,
   so a Lima that changes this again fails a test rather than a probe nobody reruns.

A flaw in round 2's own probe, recorded because it is the kind this project exists to catch:
its "query straight to 1.1.1.1" and "to 192.168.5.3" rows tested for any output from `dig`,
and `dig` prints its timeout to stdout, so those rows say "ok" whatever happened. They are
not evidence either way. Round 1's row for the same check printed the text and shows a
timeout. Round 3 requires an address in the answer.

**Status of the vz backend's network boundary:** TCP and UDP egress, the Mac's loopback and
the LAN over TCP: closed, measured, root in the guest included. DNS through the system
resolver: closed, measured. ICMP: closed, measured on Lima 2.3.0 (round 3), and asserted by
tier T4 on every run.

Inside the VM, all of this is made transparent to programs (they need no proxy settings) by a
resolver that answers every name with a placeholder address and a redirect of ports 80 and
443 to a small relay that reads the name from the TLS SNI or the HTTP Host and asks the proxy
for it. None of that is a boundary: with all of it removed, the VM still has no way out.

## The forwarder's way into a VM: a session running socat, over plain ssh (measured)

When first tried, `ssh -W host:port` through Lima's ssh config failed on the Mac with "Stdio
forwarding request failed: Session open refused by peer". On Lima 2.3.0 it worked in a
workspace VM (2026-11-23): that note was stale for this Lima, or was about the root VM. A
backend's `dial` still runs `socat STDIO <address>` in the guest over a session, as the fake
backend does over `docker exec`, because a target may be a unix socket in the VM (a
workspace's proxy), which `-W` does not reach. The base image carries socat.

**The session is plain ssh, not `limactl shell`** (2026-11-23, `host/vm/lima.ts`,
`sessionArgs`): `ssh -F <LIMA_HOME>/<vm>/ssh.config -o LogLevel=ERROR -T lima-<vm> -- <line>`,
on Lima's own control connection, which its ssh.config names. `limactl shell` was a Go
program that built the same ssh and waited on it. Measured on the M1 Max, Lima 2.3.0:

| What | `limactl shell` | plain `ssh` |
|---|---|---|
| one `<vm> true` | 77 ms, 0.05 s of CPU, 87 MB peak | 8 ms, under 0.01 s, 1.5 MB peak |
| a held session | 83 MB for limactl, 1.5 MB for its ssh | 1.5 MB (3.3 MB resident) |

300 plain ssh sessions held at once in one workspace VM all answered (982 MB resident
together); sshd allows 1,000 a connection there and in the root VM (`MaxSessions`). A session
over ssh ran `socat STDIO TCP:...` and returned the guest sshd's banner. Killing the local
client leaves the remote program running in both forms, so that did not change.

What the line is, and why: every argument, the working directory and every `KEY=value` go
through one quoting function, since ssh hands the VM one string where `limactl shell` took
words (in-source table: spaces, quotes, `$(...)`, backticks, `;`, `&&`, a newline, a tab, a
leading dash, an empty string, a glob, `~`, a non-ASCII name, 100 KiB, each run by a real
`sh`). It runs in a login shell, `"$SHELL" -l -c`, as limactl ran it, because the VMs'
profiles hold what their commands rely on (the git VM's `GIT_NO_LAZY_FETCH`; the root's git
config for its login user). Root in a workspace VM is `sudo`, root in the root VM is ssh as
root on its own control socket (`rootSshArgs`), both as before. A terminal (`-t`) is asked for
only by `attach`, when a person is at one both ways; limactl 2.3.0 asked for one only when its
own stdout was a terminal, which attach never gave it, so until then an attached program had
none. ssh sends a variable only where `SendEnv` names it, and neither the line nor Lima's
ssh.config does (with `-F`, no other ssh configuration is read), so the Mac's proxy variables
reach no VM. A VM that is not running is refused before ssh starts, in desolate's words with
its fix (`vmStatus`, which reads Lima's files and starts no process). `limactl` stays for what
changes a VM: create, clone, start, stop, edit, delete.

The egress path's throughput, guest to a listener on the Mac's loopback: 366 MB/s for one
download, about 50 to 70 MB/s each for six at once (two of eight failed to connect in that
burst; not investigated).

## Section 4.4. Ports: Lima's own forwarding is turned off (measured)

Lima forwards a guest's listeners onto the Mac by itself: `127.0.0.1:5173` appeared in 0.3 s;
with the same port in two VMs the first VM wins; and **a guest listening on port 80 was
published on `*:80`**, every interface of the Mac (v2's L3 again). So every desolate VM has
`portForwards: [{guestPortRange: [1, 65535], ignore: true}]`, and desolate's forwarder is the
only way in.

## Section 4.2. dockerd and the devcontainer CLI inside the VM: work (measured)

On the M1, in a Lima/vz VM: an image with two features (node, docker-in-docker) 87 s cold and
0.3 s when already built; a Dockerfile spec 19 s; a compose spec 7 s; `docker run` inside the
docker-in-docker devcontainer worked. The 87 s is what a domain template (C3) saves every
workspace after the first.

## Section 5.3. A push is approved on the host, outside every VM (decided; the terminal approver is the default)

**What it was.** The write key is held by an ssh-agent that runs a check before every
signature, and the check passes only against an approval on file. In the first v3 cut the
approval was filed by a program in the root VM that asked on a terminal. A program in the
root VM that fabricated a terminal could answer it, and so could a harness on the host that
ran `desolate push` on a pseudo-terminal (the tests' `person.py` is exactly that).

**What it is now.** An approval is a signature made on the host:

1. the keyring issues a challenge: a short text naming the repository, branch and commit,
   with a nonce of its own (`release/shared/approval.ts`);
2. the host's approver shows that text's contents to the person and signs it
   (`release/host/approver.ts`);
3. the keyring files the approval only if the signature verifies against the approver's
   public key, which the host installed as root at `/etc/desolate/approver.pub`, and only
   for a challenge it issued, once, while it is outstanding (see "The limits effort").

Nothing in the root VM holds the private key, so nothing in it can approve: there is no
sudo rule and no confirmation program there any more. `desolate push` does the three steps
itself. A raw `git push origin <branch>` in the root's terminal goes to
`git-remote-desolate-push`, which leaves the challenge where the host can read it and waits
for `desolate approve`, run by the person on the host. It is a remote helper and not the
pre-push hook because git authenticates to the remote, which takes the write key's
signature, before it runs pre-push (measured: the first cut's hook could never have asked).

**What the gate is for.** The Mac and the root VM both hold sensitive things (the Mac
controls every VM; the root holds the write keys). Code that is not trusted is never run in
either: that is a rule the person follows, not one desolate can enforce. Given the rule,
the approval is not there to stop a hostile program on the host. It is there so that
nothing in a workspace, and no well-meaning automation (an agent harness driving
`desolate` on the host), turns an offer into a push without a person having read which
commit goes where.

**The two approvers.**

- `terminal` (the default everywhere): a key file in `~/.desolate/approver`, used after
  the branch name is typed on the controlling terminal. It needs nothing compiled and has
  run on every tier that has run.
- `touchid` (`DESOLATE_APPROVER=touchid`, macOS only, opt-in): a P-256 key made in the
  Secure Enclave with `userPresence` access control
  (`release/host/approver/touchid.swift`, compiled by bootstrap with `swiftc`). It signs
  only after Touch ID or the login password, so a program running as the person cannot make
  it sign or copy it. **This file has never been compiled or run** (it was written on
  Linux). It was the macOS default for one pass; it is opt-in now because, under the rule
  above, what it adds over the terminal is small (next paragraph, second point), and an
  unrun Swift file should not stand between a new user and their first bootstrap.

**What is left, said plainly.**

- With the `terminal` approver, a program running as the person on the host can read the
  key file or fabricate the terminal. It stops everything in the VMs; it does not stop the
  host's own processes.
- With either approver, a program running as the person on the host controls the VMs: it
  can enter the root VM as root (by ssh as root with Lima's key, which is a file in
  `~/.desolate/lima/_config`) and read the write key itself.
  The approval gate is then beside the point. Closing that means the write key must not be
  in a file anywhere: the next step is a write key that is itself a Secure Enclave key (GitHub
  accepts `ecdsa-sha2-nistp256` deploy keys), served to the root's ssh by an agent on the
  host, so every push signature is a Touch ID. Not done; it changes the keyring's shape.
- An approval names a commit, but ssh authentication cannot be bound to what is then sent.
  While an approval is live (two minutes at most to be claimed; then as long as its push,
  which revokes it; eight signatures), a process in the root VM that pushes straight to the
  remote with `--no-verify` could send another commit to that repository. The pre-push hook
  refuses that for everything that does not skip hooks.
- No prompt appears by itself: an approval is always started by the person, from the host
  (`desolate push`, `desolate approve`). A process in the root VM can leave a request; it
  cannot make a dialog appear.

## The root has no editor (decided; reverses the first cut)

The first cuts ran an editor in the root VM, in Restricted Mode, for reviewing offers. It
is gone (`release/root/editor.sh` and its settings are deleted). An editor is a large
program whose job is to interpret a tree: tasks, launch configurations, language servers,
extensions that activate on a file's presence. Restricted Mode is the editor's promise to
hold all of that back, and the root is the one place where the tree being looked at was
written by an agent and the keys are next door. What the person needs in the root is
smaller:

- **the dashboard**: what needs them, and for an offer the commits, the files, the
  warnings, and the diff;
- **a diff that is text**: `git diff --no-ext-diff --no-textconv`, in pages of 256 KiB, put on
  the page as text nodes (`release/root/ui/dashboard.js`, `diffView`) and on the terminal
  by `desolate review <domain> <repo> <branch> --diff` with control characters replaced.
  Nothing in it is parsed as markup, and it is shown only if it is of the commit the Push
  button names;
- **a terminal** (`desolate root shell`), for people who prefer git's own commands. The
  root's git settings (next section) are what make that safe to do on a tree an agent wrote.

Editing happens in workspaces, where every workspace has an editor.

## What the root takes from a domain, and how (audited; two holes found and closed)

The root reads four kinds of thing a domain wrote: bundles, the list of refs, LFS objects,
and small JSON files (requests, statuses). A domain's VM has the outbox mounted read-write,
so everything in it, the directory entries included, is the domain's to shape. An audit by
test (`tests/v3/t2/10-hostile-content.test.ts`, and the same route over a real VM's share in
`tests/v3/t3/`) found two holes in the previous cut, both
closed here; `release/docs/incidents.md` has them as incidents.

**1. The directory is checked once, and then held.** (`release/root/outbox.ts`.) The root
opens an outbox directory with `O_DIRECTORY|O_NOFOLLOW`, and takes it only if the kernel's
own name for the open descriptor is the path under the root's `domains/` it meant to open.
Files are opened by name relative to that descriptor, `O_NOFOLLOW`, regular files only,
within a size limit (JSON 1 MiB, a bundle 2 GiB, an LFS object 5 GiB). Removal is of a
name in that checked directory and nothing else. *The hole this closed:* with the sync
directory replaced by a symlink into the root's own state, the root removed a file of its
own through it.

**2. git is never given a path a domain controls.** A bundle is copied, through the open
descriptor, to a directory only the root can write (`/var/lib/desolate/incoming`), under a
name the root made, and git reads the copy. One at a time: copy, check, fetch, delete, so
the root's own disk holds one bundle of a domain's at once.

**3. Every object is checked before any enters a root clone.** The copy's pack is indexed with
`git index-pack --strict` into a throwaway object directory that borrows the clone's objects
(`refusedBy` in `release/root/git-remote-desolate.ts`); only a bundle that passes is fetched.
Only a v2 bundle is looked at (what a workspace's git writes; v3 exists to carry a filter that
leaves objects out, or another hash), and a check that runs longer than a minute plus a second
for each MiB of the bundle (`checkMs`) is a refusal. `--strict` is git's fsck with its errors
fatal: a tree with `.git` in it (in any case, or in a form macOS or Windows would fold to it),
a `.gitmodules` that is a symlink or names an option or a climbing path, a malformed object.
*The hole this closed:* `fetch.fsckObjects` does not apply to a fetch from a bundle on the
image's git (2.43): a tree containing `.git` was imported and offered.

A domain's bundle carries all its branches, so one branch with such an object gets the
whole bundle refused. That is deliberate (a bundle is taken whole or not at all), and it
is said three times: to the workspace that offered, on the dashboard, and in `desolate
offers`. It clears when the branch is deleted in the domain and the next bundle is taken.

**4. An LFS object is the bytes that were hashed.** It is copied from one open descriptor
while being hashed, and the copy becomes the root's only if the hash is its name and the
size is the pointer's. (Before: verify, then copy by path, which a domain could have
swapped between the two.)

**5. The root's git does not act on what a tree says.** In the root's global git config
(`release/root/start.sh`): `transfer`/`fetch`/`receive.fsckObjects`; `core.protectHFS` and
`protectNTFS` (the Mac's and Windows' ways of spelling `.git`, refused on Linux too);
`core.fsmonitor=false`; `safe.bareRepository=explicit`, so a directory in a checked-out
tree that is shaped like a repository is not one, whatever its config names; `protocol.allow
=never` with only `file`, `ssh`, `https` and desolate's two helpers allowed;
`submodule.recurse=false` and `fetch.recurseSubmodules=false`. Diffs desolate itself makes
use `--no-ext-diff --no-textconv`. Hooks, filters, diff drivers and aliases need config,
and a tree cannot supply config: `.gitattributes` can name a driver, only the root's own
config can define one, and it defines none. The test has a control for this: the same
planted repository does run its program with `safe.bareRepository=all` given for one
command.

**What is left, by nature.** These are surfaces that cannot be removed, only kept small:

- **git's own parsers** read a pack an agent wrote (`index-pack`, then `fetch`, `diff`,
  `log`). A memory-safety bug in git's pack or object parsing would be reachable. Keeping
  the image's git current is the mitigation; desolate runs that parsing as the root's
  ordinary user, never as root, and never as the keyring's user.
- **JSON.parse** on files up to 1 MiB, then field-by-field validation
  (`release/shared/names.ts`).
- **The proxies** parse what workspaces send (HTTP CONNECT, TLS ClientHello in
  `release/root/proxy/proxy.ts`; full HTTP in mitmproxy, for secret hosts only), and the
  root's resolver answers their DNS.
- **Size.** A domain can fill its own outbox and its own share, and what it commits ends
  up in the root clone when it is taken. Each file the root reads is bounded (counted
  while reading, not trusted from its size), a bundle is at most 2 GiB and is handled one
  at a time, and a slow pack is cut off. What is not bounded is the total: there is no
  quota on a domain's share, and a pack built to expand can still use a great deal of
  memory in `index-pack`. That costs availability, not integrity.
- **The person.** `git checkout dev/branch` in the root's terminal writes an agent's files
  into the root clone's work tree. Looking at them, diffing them and committing on top of
  them is safe under the settings above. *Running* them (`npm install`, `make`, a script,
  opening the folder in a tool that runs tasks) is running untrusted code in the root, and
  nothing can make that safe. The README says so first.
- **Your terminal.** `desolate exec` and the root shell show you a VM's output as it is:
  you asked for it, as with ssh. Everything else desolate prints that began in a workspace
  (a status, a branch name, a commit subject, a diff, why a devcontainer failed, why a
  bundle was refused) has its control characters replaced first, and the dashboard puts
  all of it on the page as text.
- **Status files and notes** (`release/shared/status.ts`) live in the domain's clone, and
  the root and the host both show them. They are opened without following a link, checked
  on the open descriptor (a regular file, a bounded size), and refused unless the file
  that was opened is the one that was meant. In the root VM that last check is asked of
  the kernel about the open descriptor, so nothing can be swapped. On the Mac, node has no
  such question to ask: the path is resolved a second time and must name the same device
  and inode. A domain that wins that race (a directory swapped for a link and back within
  one read) gets text from a file the person can read shown to that same person. It is
  never acted on, and never returned to a domain.

## The root VM's ordinary user is not root (decided on the Mac; measured)

Lima's cloud-init gives its login user `NOPASSWD: ALL`, and writes that rule again at every
boot (measured: removed, rebooted, back). In the root VM that user runs everything that
parses what a domain wrote: git on its packs (rootd), each workspace's proxy and each
domain's secrets proxy, and the state service. With sudo, the keyring's own user (which
holds the keys, 0700) separated nothing from a bug in any of those.

- **The rule.** `root/start.sh` writes `/etc/sudoers.d/99-desolate` (`<user> ALL=(ALL)
  !ALL`). It sorts after cloud-init's `90-cloud-init-users`, and in sudoers the last match
  wins, so it holds across boots without fighting cloud-init (measured: after a reboot
  `sudo -n true` is refused, and Lima still starts the VM, in 9 s). `start.sh` tries sudo as
  the user and refuses to start any service if it works; `doctor` asks the same.
- **The host's way in** is ssh as root with Lima's key for desolate's home, on a control
  socket of its own (`host/vm/lima.ts`, `rootSshArgs`). The key goes into root's
  `authorized_keys` once, through the login user's sudo, at the first bootstrap, before
  `start.sh` has ever run. It is taken from the host's own copy of the public key, never
  from the user's `~/.ssh` in the VM (which that user could add a key of its own to).
- **What root and the keyring rely on is root's.** `/var/lib/desolate` belongs to the user
  (rootd writes its registry there by rename). Anything in it, the user can replace with a
  link, so the keys, the hooks, the mirrors' hooks and git's settings moved to
  `/var/lib/desolate-root`, and `start.sh` makes the user's directories as the user. Before,
  `install -d -o <user> /var/lib/desolate/secrets` as root followed a link the user
  planted there and handed it the directory the link named (T2 `01-root` plants three).
- **Workspaces are unchanged**: their login user keeps sudo, because root in a workspace is
  already the workspace's (P5: nothing inside a workspace VM is a boundary).
- **Not yet:** the proxies run as the same user as rootd, and a domain's secret values are
  that user's files. A bug in mitmproxy reached through one workspace could read every
  domain's secrets, and write root clones. The next step is a user for the proxies, with
  each domain's secrets readable by that domain's secrets proxy only.

## A domain's template (C3): built in a workspace-shaped VM, cloned for the rest (measured)

`release/host/templates.ts`. On `up`, before the workspace takes its checkouts, the host asks
the root for the domain's environment as published (`domain.env-key`: the git id of
`.devcontainer/` or `.devcontainer.json` on the environment repository's default branch,
read in the mirror). If no template has that key, one is built: a VM made exactly like a
workspace of the domain (its shares, its proxy, its rules), which runs the spec, then has
what is one workspace's removed (its editor's token, its identity, logs, containers) and is
stopped. Every workspace of the domain is then a `limactl clone` of it.

Measured on the M1 with microsoft/vscode-remote-try-node (an mcr.microsoft.com image, an
npm install after create):

| | total | of which |
|---|---|---|
| a workspace from the base, no template | 54.0 s | VM 9.0 s; pull, build, install, editor 44.4 s |
| the first workspace with a template (built now) | 71.6 s | template 53.8 s; VM 9.3 s; the rest 8.2 s |
| every later workspace | **18.8 s** | template 0.5 s; VM 9.4 s; the rest 8.5 s |

The spec's target is 15 s: the VM's boot is now half of it, and has no cache (vz has no
suspend). Two clones' editors had different tokens.

Why this is safe (section 4.7's rule): the template is the domain's code's output, built
with the domain's trust and nothing more, and cloned only for that domain. The key covers
the spec and what made the VM (`provision.sh`, `pins.env`, `devcontainer.ts`, `editor.sh`), so
a change to either builds a new one; a domain's other templates are removed then.

Not done: `onCreateCommand`'s results are not carried (each workspace makes its own
container from the template's images); C2 (a pull-through registry) and C4 (package
caches) are not built, so a template's first build and each workspace's `npm install`
still go to the network. Not on the fake backend (its clone carries no docker images).
Not covered by a test that builds one: the tiers have no registry. T1 covers the key and
the name.

## Each domain's proxies run as a user of that domain's own (decided on the Mac; measured)

Each workspace's `proxy.ts` and each domain's mitmproxy parse everything a workspace sends.
They ran as the root's ordinary user, so a bug in either reached what that user reaches:
the keyring's sockets (every read key signs for it), the root clones and mirrors (a hook or
an `fsmonitor` in a clone's config runs as the user at its next git command), and every
domain's secrets. A first step gave all proxies one user of their own; that still let a bug
reached from one domain read every domain's secrets. Now:

- **`dsp-<10 hex>`, one per domain** (`root/proxy-user.sh`, run by root: by start.sh for
  every domain there is, and by the host, through its own way in, when a domain's proxies
  are first wanted). Each is in the group `desolate-proxies` and in no group of the root's
  user, so the keyring's sockets refuse it. The root's user may run programs as any member
  of that group (`<user> ALL=(%desolate-proxies) NOPASSWD: ALL`, the last line of
  `99-desolate`): safe in that direction, since the root's user holds all any of them holds.
- **Two directories per domain, in root's `/var/lib/desolate-proxies`**, where nothing of
  the root's user's is on the way: `domains/<d>` (the root's user's, group: the domain's
  proxies, 2750) holds the policy, the secret values, where the secrets proxy listens and a
  handoff token; `out/<d>` (the domain's proxies', group: the root's user's, 2750) holds
  their audit log and the domain's CA.
- **The handoff token.** A secrets proxy listens on the root VM's loopback, where any user
  can connect. It opens a tunnel only for a connection that shows its domain's token, which
  only that domain's proxies (and the root's user) can read. Measured on the M1: another
  domain's proxies' user, given the port, got 403 without the token and with a wrong one;
  the domain's own, with it, 200; reading the domain's secrets file: permission denied.
- **The shares are closed to all of them** by `/desolate` (root, the root user's group,
  0750), not a share: on vz any user that reaches a share can write it (previous
  section). Their code is a root-owned copy at `/opt/desolate/proxy-code`.
- `doctor` asks, for every domain's proxies' user: it can be started, shares no group with
  the root's user, cannot reach `/desolate/root`, and cannot reach any other domain's
  directory. T4 tries as domain a's proxies to write each share and ask the keyring, and as
  another domain's to read a's secrets and use a's secrets proxy, each beside a control.
- **Left:** a domain's proxies have the internet (they are its way out) and read its
  secrets; a bug in them reached from that domain's own workspace can leak that domain's
  secrets. That domain's workspaces can already use them.

## The pusher: the one user that reaches a write key, and it parses nothing (decided on the Mac; tested on T1 and T2)

The independent audit's F6: the root's ordinary user parses everything a domain sends (git on
agent-written packs, outbox JSON, the dashboard's state) and it also pushed, with the write
agent open to it for as long as an approval lasts, eight signatures. A bug in any of
those parsers could push another branch of that repository, or another commit, in the window.

- **A user of its own.** `desolate-pusher` (root/pusher.ts) is the only user that can enter
  `/run/desolate/keyring-write`, where the write agent's relay is (the keyring's directory,
  the pusher's group, 0750). The root's user cannot open it (doctor asks, by trying), and
  is not in the pusher's group; the pusher is not in the root's user's group, so `/desolate`
  (every share) is closed to it. Its code is root's copy in `/opt/desolate/proxy-code`.
- **It is told an id, and it parses nothing it is sent.** The root's user hands it the
  approval's id, a pack and the LFS objects. The pusher asks the keyring what the id names:
  repository, branch, commit, and `onto`, what the remote's branch is now (or none). Then
  it speaks git's push protocol to the forge itself: it reads the forge's ref list, stops if
  the branch is not exactly `onto`, asks for the one update `<onto> <commit>
  refs/heads/<branch>`, and forwards the pack as bytes, counted and never read. The forge
  applies the update atomically or not at all, and cannot point the branch at a commit the
  pack does not hold. LFS objects are hashed as they arrive and uploaded from a repository
  with no git object in it. T1 runs this code against a real `git receive-pack`: a pack of
  another commit, a stale `onto`, and bytes that are not a pack all move nothing; T2
  `04-offers` hands it a live approval's id with another commit's pack: no ref moved.
- **Why it parses nothing.** The first version fetched a bundle from the root's user and
  ran git on it, as the pusher. The audit of that version: a bug in git's pack parsing that
  compromised the root's user could be sent straight on to the pusher, which would then
  hold any live approval's signatures for that repository. No other user in between fixes
  that, since the same bug works again on each. A process that never parses those bytes does.
- **`onto` instead of a force flag.** Every approval says what the branch moves from, so a
  push is a compare-and-swap whether it builds on the remote's branch or replaces it, and a
  remote that moved since the approval refuses it. Whether the commit builds on `onto` is
  for the person to see, from the reviewer (step 2 of this plan), not for the pusher to
  decide; the raw `git push` helper still wants a `+` for one that does not.
- **Where it pushes is root's word.** The forge's address and host key are read from
  `/var/lib/desolate-root/forge.json` and `known_hosts`, written by root from what the host
  sends at every bootstrap (root/forge-pin.ts), not from the root's user's copies.
- **One push per process, one push per approval.** The pusher exits after each push, and
  root's supervisor kills every process of its user before starting the next, which empties
  the user's home first. Asking the keyring what an approval names claims it: only a claimed
  approval lets the write key sign, a claim lasts while the pusher's connection to the
  keyring does (the root's user must hand the push over by `handOverBy`), and an approval
  is claimed once.
- **It says what it knows.** Once the ref update is asked for, the forge may take it as soon
  as the pack is whole; a failure after that (the root's user stops sending, say) is
  reported as "may have reached the remote", with the forge's report used if it came, and
  never as "nothing was pushed" (the second review measured the update landing during such a
  stall). Asked for a push that already landed, the pusher answers that it is done.
- **What is left.** Inside one approved push, the root's user can add objects the commit
  does not need to the pack, and LFS objects it does not name: both reach the forge,
  unreferenced (on a public repository, readable by anyone who knows their hash). That is a
  way out for data only for a user that has no other, and this one has the network. It can
  withhold a push, or ask a person to approve a commit of its choosing, from an `onto` of its
  choosing: the terminal prompt shows both ids, and whether the commit builds on `onto` comes
  from that user's own review there; the approval page shows the reviewer's account instead
  (step 2). Revoking an approval is open to it too, which only cancels. The pusher reads one
  JSON line it is sent (at most 4 MiB, node's parser), and nothing else.

## One click to approve, on a page the host serves (decided on the Mac; tested on T1 and T2)

The person works at a monitor away from the Mac, so Touch ID is out, and typing the branch
name in a terminal is friction that a script on the Mac can fake anyway (the terminal
approver's documented limit). What the page has to be is: something only the person's own
browser tab can make sign, and something that shows what is being approved truthfully.

- **Who can make it sign.** The host daemon serves it at `desolate-approve.localhost` on the
  editors' port, in-process (host/approve-web.ts): never a VM. It signs only for a request
  that has all of: a cookie (HttpOnly, SameSite=Strict, a name of this stack's own) that only
  the address `desolate approve --web` prints gives, and nothing in a VM has that address's
  token; `Sec-Fetch-Site: same-origin` and the exact Origin (the browser says these, and a
  workspace's page, on its own name, cannot say them as this page); a JSON body (so no other
  origin's form can send it); a token per push that only the page's script can read (it is
  in a JSON answer no other origin can read), computed over the very text the page showed;
  and the commit the person was shown. The list of waiting pushes is the root's user's, and
  the review of this page found it could show a decoy and then list the real text under the
  same nonce at the click: the token over the text makes that sign nothing (T1 tries it).
  T1 tries each missing; T2 approves and refuses through the real daemon, and loads the page
  in Chrome.
- **What it cannot be tricked into.** No framing (`frame-ancestors 'none'`, X-Frame-Options),
  no inline script, no opener (COOP), no referrer. A page an agent wrote could open it in a
  window timed to land under a click; its Approve button arms only after a second of the
  tab's visibility and focus, a second in which that card has not changed, and a pointer
  that then moves over it, and takes a click only a third of a second after that, and no key
  press. Any change to the page disarms every button, and a push no longer waiting keeps
  its place, greyed, so nothing shifts under a still pointer.
- **Why this is not theatre.** Nothing an agent controls can reach the cookie, read the
  page, send the headers, or click inside it; the only path is the person's own click, in
  a tab on their Mac, on a card that says what it approves. What it does not stop is a
  program on the Mac running as the person, which could read the token file: the same
  limit as the terminal approver, and the rule (nothing untrusted runs on the Mac) covers it.
- **What it shows.** Repository, branch, commit and onto are parsed on the host from the text
  that is signed. What the push would send (the commits the remote lacks, the files, whether
  it builds on `onto`) is the reviewer's (root/reviewer.ts): a user of its own, with no write
  key, asked by the host as root about those ids only. Its objects come from the root's user,
  but a commit id is the hash of its content; the remote's branches it reads from the forge
  with the read key, not from the root's user. Each summary is a process of its own, started
  by root for the host (the root's user can neither ask for one nor hold one up), and it
  comes in the background, with a deadline, so a slow reviewer never holds up the list.
  What runs on the forge (`.github/`, `.gitmodules`, `.gitattributes`, ...) is listed first,
  however many files change; binary files and LFS objects are marked. So a root's user
  compromised through anything but git itself cannot make the page lie. One compromised
  through a bug in git's own parsing could send the reviewer the same bug, and a reviewer
  compromised once could leave objects in its store that later summaries trust (git does not
  re-hash a pack it already indexed): the reviewer's account is as good as git's parsing, and
  it has nothing to push with. The root's user's own words about a push are not shown.

## The git VM: the person's git, in a browser tab, beside nothing (decided on the Mac; tested on T2)

The person wants to use git as they do anywhere, typed in a browser (the monitor is away from
the Mac), without anything an agent wrote getting to run. `desolate root shell` was a bash in
the root VM, as the root's user: beside the keyring's sockets, every domain's share, the
proxies, and the dashboard.

- **A VM of its own** (host/git-vm.ts): no network at all (the same confinement as a
  workspace's, and no link), no key, no project tooling. Its shares: the person's own clones
  (`~/.desolate/git`, read-write), the mirrors and the root's clones (read-only: `origin`
  is the mirror, `root` the root's clone, whose `<domain>/*` are the offers), and an out-box
  the host reads. Its git is set so that nothing a clone holds runs: no hooks but its own
  empty directory, no fsmonitor, no submodule fetching, no transport but files and the push
  helper, every object checked; `less` passes colour only (`-R`) and runs nothing
  (`LESSSECURE`), vim reads no modelines.
- **Why not the root's clones, read-write.** A clone's `.git/config` can name programs
  (`core.fsmonitor`, `core.pager`, a diff driver, ...), and the root's user runs git in its
  clones. A git VM that could write them could make the root's user run what it named. So
  the person's clones are the git VM's own, and the root reads none of them.
- **A push** (git/git-remote-desolate-out.ts): `git push origin <branch>` leaves a bundle of
  the commit, its new LFS objects and the request in the out-box; the host moves them where
  the root reads them and asks the root (`git.push`), which checks every object as it does a
  domain's bundle (root/intake.ts), takes the commit in, and pushes it as a raw push is:
  through the reviewer, the approval page, and the pusher (root/raw-push.ts). The answer
  comes back to the git VM's terminal.
- **The terminal** (host/git-web.ts) is the host daemon's, at `desolate-git.localhost`: the
  same gate as the approval page (a cookie only `desolate git`'s address gives, the page's
  own origin, JSON bodies, a token per shell), and xterm.js vendored by hash (no CDN), with
  links that do nothing, no clipboard addon and no title. A shell is `bash -l` under a small
  pseudo-terminal in the git VM (git/terminal.py, run with `python3 -I`).
- **The out-box is the git VM's, so the host follows no name in it** (the review of this
  step found that the first version did: a link where the host wrote its answer would have
  had the host overwrite any file of the person's; a linked LFS directory would have had it
  move and delete files elsewhere; a file swapped between check and read could hang the
  daemon; a file the git VM still held open could be changed after the root checked it).
  Now the host opens each file without following a link, checks it is a plain file of a
  bounded size, and copies it into a file of its own (an LFS object hashed on the way); the
  git VM keeps no hold on what the root reads. Answers are written to a directory the git VM
  can read and not write. One request at a time; a request that cannot be taken is answered,
  never left to stop the daemon.
- **The root's clones are there to fetch from, not to work in.** Their config is the root's
  user's, and git follows a repository's own config: the git VM's shell refuses to run git
  inside `/desolate/root` or the mirrors, the first clone is `--no-local` (every object
  checked), a fetch's upload-pack has its command-naming settings pinned from this side, and
  `GIT_NO_LAZY_FETCH` is set.
- **LFS files check out** (fixed on the Mac; T2). No LFS file had ever checked out in the git
  VM: git-lfs's own file transfer runs `git rev-parse` inside the bare mirror, which the git
  VM's `safe.bareRepository=explicit` refuses (kept: it guards against a clone's embedded
  repositories). The git VM's clones use desolate's own transfer agent (`git/lfs-file.ts`):
  downloads only, from the mirror's store or the root clone's (where offered objects are),
  each copied without following a link and kept only if it hashes to its name and size.
- **What is left.** The terminal draws bytes a file or a commit holds: xterm.js interprets
  escape sequences, and a bug there is a bug in the person's browser tab (no more: the tab
  has no token but its own, and an approval still needs the approval page's click). A
  connection is routed by its first request's name, and each page refuses a request for
  another (found by T2: a kept-alive connection carried a second name).

## The root VM does not reach the Mac's loopback (measured on the M1; tested on T4)

Lima's network gives each VM the subnet 192.168.5.0/24, and in it addresses that are the
Mac's loopback: the gateway, 192.168.5.2 (on QEMU's network, every address of the prefix but
the resolver's, and IPv6 too). From the root VM (measured, 2026-11-12) the host daemon's port
answered (the approval page: 200), and so did the Mac's own ssh. The root's user parses what
domains send, and the host daemon is where approvals are signed and the git terminal runs: a
bug in one of those parsers should not be a connection to every local service of the Mac.

- **The wall** (root/wall.sh, nftables, root's). To Lima's subnet: replies in flows the host
  opened (its ssh in, its dials to the root's proxies), DNS to the resolver, DHCP to the
  gateway; nothing else, and not flows this VM opened before the wall either. No private
  range (the Mac's LAN address, a VPN's: the Mac's sshd listens there too) and no IPv6 but
  loopback: the root needs the internet only. Traffic through the gateway to the internet has
  other addresses and is untouched (measured: GitHub over ssh and https, a fetch). What this
  VM's sshd sends back is also allowed by its source port (22, root's to bind; the sysctl
  that keeps it root's is set): on a fresh VM the last packets of the host's ssh session were
  taken for new ones and refused, and bootstrap hung (T4 found it).
- **Always there.** The host sets it at bootstrap before the root's services start; a boot
  unit sets it again before the network and ssh come up, from root's own copy (measured: after
  a reboot, before any bootstrap, it is in place); start.sh sets it at every start, and on a
  real VM nothing that reads a domain's data starts without it (`--required`).
- **Asked, not assumed.** `doctor` opens a listener of its own on the Mac's 127.0.0.1 and
  tries it, as the root's own user, at 192.168.5.2 and .3, and checks the wall is there. T4
  does the same, and IPv6, as that user and as root.
- **Tests only:** a stand-in forge on the Mac's loopback or a private address is let through,
  by port or address, when the host is in a test run (`DESOLATE_TEST_RUN`) and names it.
- **What is left.** Root in the root VM can take the wall down: root runs nothing untrusted
  (the rule), and the root's user cannot become root (decided above). The Mac's public
  addresses, if it has any, are the internet's.

## `desolate events`: what happened, and from whom (decided on the Mac; tested on T1 and T2)

The person's own scripts on the Mac (a pull request on every push, a notification on an
orange status) want to hear of things as they happen. The host daemon gathers them and
streams JSON lines (host/events.ts); every event names its source, because that is how far
it can be believed:

- **`pusher`**: from the pusher's log, which only root writes, read as root by the host (the
  root's user can neither write it nor stand between: a stream through that user's shell
  could be its own). What it says is the keyring's record of the approval and the forge's
  answer. `pushed` means the remote has that commit on that branch.
- **`host`**: what the host did itself (an approval signed on the page, from the signed text;
  a workspace started or stopped; a push the git VM handed it).
- **`root`**: the root's state service, diffed (a long poll the host makes with its own
  token). That user parses what domains send, and the text is an agent's: offered branches,
  statuses, refusals, pushes waiting. Their strings have control characters and
  bidirectional overrides taken out (a script that prints them prints no escape sequence),
  and the docs say to act only on `pusher` and `host` events when it matters. A name it
  reports (repository, branch, commit, domain) is one desolate would make, or `null`, so a
  script can pass it on as an argument (no valid one starts with `-`).
- **Bounded.** A listener that stops reading is let go with a `lagged` line rather than piling
  lines up in the daemon (which also serves the approval page); the state is looked at no more
  than four times a second and at most 16 MiB of it, and one change yields at most 200 events
  per domain, then one `events-dropped` saying how many more. The pusher's log is read by
  bytes, by file identity and size, and only while someone listens. (Its review found
  `--replay 0` replaying everything, unbounded buffering, an offset that could drift and
  re-announce old pushes, and the unvalidated names; all fixed.)

## What a checkout has checked out, live: the Mac's file events (decided on the Mac; tested on T1, measured on the M1)

The dashboard and `desolate list` showed each checkout as it started (`@main` after the agent
had switched to `feature/greeting`). They now show its HEAD, read as data like a status file
(`shared/status.ts` `readHead`): a name desolate would carry or nothing, a link never followed,
and a HEAD with no closing newline is one caught half written (seen on the M1: a read from the
root VM returned `ref: refs/heads/live-`), so the last settled value stands.

Listening, not polling. A VM gets no events for a share, but a share's files are the Mac's: a
write from any VM is a file event on the Mac. The host daemon already watched each checkout's
git directory for its status; it now also nudges for `HEAD`, and, on macOS only, holds one
recursive FSEvents watch per repository on `refs/heads` and one on `packed-refs`. A directory
there that is a link, or resolves outside the domain's tree, is not watched (a recursive watch
would follow it). Measured on the M1: a `git switch` or a commit in a workspace is on the
dashboard, and a `head` event in `desolate events`, about 200 ms later. The state service's
look every second stayed, for a missed event (every 10 s since #258, when the refs/heads
watch gave way to one on each repository's list of branches in the outbox). The git VM's outbox is taken the same way (a
watch, with a look every 5 s behind it). The workspace's own refs watch (`wsd`, every 3 s)
and the root's outbox look (`rootd`) still poll: those run inside VMs.

## Every branch is the root's to read, and reviewable; an offer is "ready" (decided on the Mac; tested on T1)

A workspace writes every branch out as it changes (`wsd`: a bundle and its list of refs,
every few seconds), but the root brought a domain's branches into its clones only when one
was offered or reviewed, so `git fetch root` in the git VM showed only those. `rootd` now
imports a repository's branches when the domain's list of them changes (by the file's time
only), at most one import every 3 s per repository, by the same path a review takes
(`fetchDomain`: git-remote-desolate, every object checked). Two imports at once in a clone
can meet on a ref's lock; the later one tries again. This is not a new way in: a domain
could already make the root import as often as it offers (in its own lane: see "The limits
effort").

The dashboard lists every branch per domain (the domain's own list, read as data: names
desolate would carry; 200 in each snapshot, those checked out first, and the total), shows
which workspace has it checked out, and reviews any of them; each checkout has a Diff button
for the branch it is on. A review is against `origin/<default>` (what a push would send) or
the domain's own `<default>` (`--against domain`: what the agents built beyond their own
main). `desolate branches` is the same list on the host. Pushing from the dashboard stays with
offered branches, at the commit reviewed: an offer is how a branch's new LFS objects reach the
root. Anything else is pushed from the git terminal, where it is one `git push`.

## In a workspace, `desolate status`; in the git VM, `desolate fetch` and a remote per domain (decided on the Mac; tested on T2)

`desolate status ...` inside a workspace is `/desolate/status ...` (the wrapper runs the
shell script itself: no node starts), which stays for whatever already calls it.

The git VM's clone of a repository has a remote for each domain that has it: `git fetch
<domain>` reads that domain's branches from the root clone (as `git fetch root` does, with
upload-pack's command fixed on this side), and its push address, `desolate-out::<repo>@<domain>`,
makes `git push <domain> <branch>` a delivery: the bundle goes the way a push does (host,
`bundleRefusal`, every object checked), and the root then runs its own `git push <domain>`
(git-remote-desolate), so the domain's workspaces see `root/<branch>`. A domain without the
repository is refused by the root. New LFS objects stay in the root (a delivery carries
commits). `desolate fetch` in the git VM asks the host, through the same out-box, to have the
root refresh the mirror (at most once in 5 s per repository), then runs `git fetch --all`.

What this opens: the git VM writes into domains without the person approving each delivery.
The git VM is the person's, but it is also where they read what agents wrote, so if git
itself fell to a domain's content, the git VM could plant a branch (never checked out:
`root/<branch>`) in another domain. It could already read every domain's work. Deliveries are
events (`git-delivery-handed`). Recorded in mac-audit-notes as accepted, with the reason.

## `desolate upstream`: suede's own script, pinned, run in the git VM; the push is an ordinary one (decided on the Mac; tested on T1 and T2; run against github.com)

move-to-vms.md 5.5 put suede's `upstream` in the root, because that was where a person
pushed. It is not any more: the root has no terminal a person types in, and the person's git
is the git VM. What `upstream` does is in two parts, and they go to different places:

1. **The split**: suede's hosted `scripts/upstream.sh`, which runs `git subrepo push`, which
   walks the consumer's history and rebuilds the dependency's commits from it (`commit-tree`,
   `filter-branch --tree-filter`, a worktree), then restores the clone. That is a large shell
   program reading what an agent wrote: the consumer's history, every `.gitrepo` in it, the
   trees it checks out.
2. **The push** of the result to the dependency's remote, as `downstream/<owner>/<repo>-<commit>`.

**Where the split runs: the git VM.** It has no network, no key, nothing of the root's, and it
is already where the person reads agents' work with git. A bug in git-subrepo, or in git, that
an agent's history could reach there gets what the git VM has: the person's clones and
read-only mirrors, and the ability to ask for a push that the person then approves on the
approval page. In the root it would get the root's user: every domain's share, the network,
the proxies, and the keyring's door. On the host it would break the host's rule (no git on
desolate's repositories). A pure-git reimplementation of the split was the fallback if
git-subrepo could not be pinned or run safely; it can be (next paragraph), and suede's own code
is what suede's own Action expects, so it is not reimplemented. What desolate does write is
the checking around it, in TypeScript, by argv.

**What runs, and from where.** suede's `scripts/upstream.sh` at `SUEDE_COMMIT` (pins.env),
vendored byte for byte at `release/git/suede-upstream.sh` and refused at run time unless its
sha256 is `SUEDE_UPSTREAM_SHA256`; T1 checks the same. git-subrepo is the image's
(`/opt/git-subrepo`, by commit, from v2). Never the copy an agent's branch vendors at
`<dependency>/.suede/core/upstream`: that is repository content, and it would also fetch the
real script from suede.sh, which the git VM cannot reach and should not run if it could.
`tools/pin-suede.sh <commit>` moves the pin. git-subrepo at that commit quotes what it reads
(`.gitrepo` values go to `commit-tree` as array elements, authors through `mapfile`), and the
values that become arguments are checked first anyway (below).

**How it runs.** `desolate upstream [<consumer>] <dependency-dir> <owner/repo> [--from <ref>]`
in the git VM (or on the Mac, which runs the same in the git VM and then waits for the pull
request). Never in the person's clone: in a scratch clone of it (`--shared`) that also
borrows the dependency's mirror's objects, checked out on a branch at the commit, with:
`origin` set to the consumer's GitHub-shaped address (suede names the branch from it); a
remote `dependency` that fetches from the mirror (so suede's "already proposed?" check and
git-subrepo's fetch read what the remote published) and pushes into a bare repository in the
scratch directory, so suede's push is captured, not sent. Only then does desolate look at what
it made, and refuse if:

- **the dependency named is not the one `.gitrepo` names** (owner/repo, case aside), or is not
  a repository desolate holds a mirror of; on the Mac, or not pushable. v2's H1 fix: the person
  names where it goes, and a `.gitrepo` that names another repository stops it. `--remote` is
  taken only if it names the same repository too (it is suede's flag; the push still goes to
  the one named);
- **any `.gitrepo` in the history git-subrepo walks has a `commit`/`parent` that is not a full
  id, or a `method` but merge or rebase** (before the split runs);
- **the split is not exactly the dependency's files at that commit** (its tree is the
  directory's, less `.gitrepo`), or the branch is not the one suede names, or it does not build
  on the release commit `.gitrepo` names, or the mirror has no such commit;
- **it changes the dependency's `.github/`** against that release commit. v2's rule: a pushed
  branch's own workflows run on the remote, with its secrets, on the push itself (suede's
  `suede-downstream-to-main` is exactly such a workflow, with `contents: write`).

It prints what the push would send, and in red when the branch changed the vendored
`.suede/core/` (suede's own machinery, which every consumer of the dependency would then run).
Then it pushes the split with `git push desolate-out::<owner/repo>` like any push from the git
VM: bundle, host, the root's object checks, the reviewer, **the approval page, which names the
dependency, the `downstream/...` branch and the commit**, then the pusher. No new path to a
write key: the dependency's key is used as for any push, only after that approval, and a
`--no-push` dependency is refused by the root as any push to it is.

**The root checks the `.github/` rule too**, for every push of a `downstream/...` branch
however it was made (a raw `git push`, or `desolate push` of a domain's branch): the commit's
`.github/` must be that of a commit the remote already has and that it builds on. The git VM's
check is for the person; the root's is for everything else that can ask for such a push.
The reviewer marks `.suede/core/` like the files that run on the forge (listed first, with a
warning), and compares a new branch that does not build on the default branch with the
remote branch it does build on (a proposal builds on `release`, not `main`), not with the
default branch's whole tree.

**Waiting for the pull request** needs GitHub's API, which the git VM cannot reach: `desolate
upstream` on the Mac waits for it (as suede does: the PR's link, a draft for conflicts,
"nothing new" when the Action removed the branch, the run's link when it failed), unless
`--no-wait`; in the git VM it says where the PR will be.

**Beside the suede factory** (`desolate factory suede`, release/factory/suede.ts). The two
start from different places and so make different branches, and both are kept:

- the factory starts from a push to a project's default branch, and has an **agent** port the
  change into the dependency's own checkout (main-shaped: the change goes under `release/`),
  in a domain that holds both, on `upstream/<project>-<commit>`; the person pushes that branch
  like any offer, and the factory opens the pull request with `gh`. It is for "should any of
  this go upstream?", and the agent's judgement and the dependency's own tests are the point;
- `desolate upstream` starts from a branch the person has already read and decided on, and
  needs **no agent and no domain holding the dependency**: the split is mechanical, it is
  release-shaped, and it goes to suede's own `downstream/<owner>/<repo>-<commit>`, so the
  dependency's `suede-downstream-to-main` Action rebuilds it onto main and opens the PR,
  exactly as for a consumer anywhere that runs suede's `upstream`.

One convention for both was considered and refused: a release-shaped split pushed as
`upstream/...` would get no PR from suede's Action (it fires on `downstream/**`) and a PR
from the factory against main that cannot be merged (the trees have different shapes); a
main-shaped branch pushed as `downstream/...` would be "rebuilt" by the Action as if it were
release-shaped. The branch name says which shape it is, and suede already decided that name.
What they share is in one place: `shared/suede.ts` (suede's branch spelling, reading a
`.gitrepo`'s remote, the `.github/` rule the root applies to every `downstream/...` push) and
the root's `suede.changed` (which directories are vendored dependencies), which `desolate
upstream` does not need, since the person names the directory. `release/docs/suede.md` tells
the whole workflow.

**Tested.** T1 `upstream` (14: every refusal above beside its control, on repositories made
with git; the root's rule; the pin). T2 `13-upstream` (5: a workspace's branch proposed through
the approval page and the pusher, with the stand-in Action's pull request; `.github/`, the
wrong dependency, a read-only one and a foreign `--remote` refused; `.suede/core/` in red and
on the page; the root refusing a hand-made `downstream/...` push that changes `.github/`, and
taking one that does not). **On GitHub** (2026-11-13, the M1, vz): a suede dependency made
from suede's template (`mitdesolate/desolate-upstream-lib`), a consumer vendoring it with
git-subrepo (`mitdesolate/desolate-upstream-app`), an agent's commit in a workspace, `desolate
upstream` on the Mac, approved on the page: the pusher pushed
`downstream/mitdesolate/desolate-upstream-app-e3006d6...`, suede's Action rebuilt it, and
`desolate upstream` printed its pull request
(https://github.com/mitdesolate/desolate-upstream-lib/pull/1, changing `release/greet.txt`).

**What is left.** The split still runs git-subrepo and git on an agent's history, in the git
VM: a bug there could make a different commit than the one the branch describes. What it makes
is then checked (its tree is the directory's), shown, and approved by the person on a page
whose account of it is the reviewer's, so the worst it can do is ask for a push the person
reads. Commit messages and authors of the split are the consumer's commits' (git-subrepo keeps
them); they reach the dependency's remote, as they would with suede anywhere. Not done: a
dependency with files in LFS (the push helper looks for new LFS objects in the scratch
clone's store, which has none; what the root then does with the push has not been tried);
and a button on the dashboard.

## Push and approve in one tab: the approval page, framed by the git terminal alone (decided on the Mac; tested on T1, in Chrome)

The approval page cannot be framed, so a push from the git terminal meant a second tab. Now
the git terminal's page frames the approval page's `/embed` beside the shell, shown when a
push waits. Merging the two into one page would have put the approval on the origin whose
page draws what agents wrote (the terminal): a bug there would be script that can approve.
They stay two origins, and:

- `/embed` names exactly one frame ancestor, the git terminal's origin; `/` stays
  `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- A SameSite=Strict cookie does not reach a frame under another site (the two `*.localhost`
  names are two sites), so the frame's credential is a key derived from the page's token,
  handed to it in the address's fragment (never sent to a server) by the git terminal's
  page, which only the person's browser can load (`/approvals-frame`, behind the terminal's
  own cookie). The frame sends it as a header. The git terminal's page knows the key and
  cannot use it: from its origin, a request with that header needs a preflight this server
  never grants, and is not same-origin (both checked; T1).
- Attention: focus stays in the terminal until a click, so in the frame the pointer over it
  counts. Arming is otherwise unchanged (card unchanged for a second, the pointer moves onto
  Approve, a third of a second).
- Clickjacking: the parent is desolate's own page, so the threat is script on the git
  terminal's origin (an xterm.js bug fed by what an agent wrote). Where the browser can say
  (IntersectionObserver v2: Chrome), Approve arms only while the button is reported visible
  and unobscured, so a frame made transparent or laid under something arms nothing. (Chrome
  works this out for a cross-origin frame as a whole: anything drawn over any part of the
  frame, even far from the button, keeps it from arming. Found when the demo's caption bar
  crossed the bottom of the frame.) Firefox
  and Safari cannot say; there that residual risk stands (it needs a script bug in the
  terminal page first).
- The frame tells the parent one number (how many pushes wait), to that origin only; the
  parent believes only that origin, and only a number.

## Small things the second promo found (decided on the Mac; tested on T2, seen on the M1)

- **No devcontainer lockfile in an agent's checkout.** A spec with features makes the
  devcontainer CLI write `devcontainer-lock.json` beside it, and the agent's `git add -A`
  committed it. desolate passes `--no-lockfile` unless the project keeps a lockfile of its own
  (then the CLI verifies it, as the project asked).
- **A domain with several repositories opens as one editor window.** The workspace's init
  (in its VM, with the domain's trust) writes `/workspaces/.desolate/<workspace>.code-workspace`
  with every checkout; `desolate editor` and the dashboard open it. The host writes nothing
  into a share a domain controls.
- **Git LFS in the container.** A repository that keeps files in LFS, in a container without
  git-lfs, cannot commit them there. desolate says so where it reports the devcontainer
  (`desolate up`, the dashboard) and names the feature to add; it does not change the
  project's environment.
- `desolate up` ends with the next two commands; its first phase is called what it is
  ("asked the root": the domain, the template check, the plan; about 0.2 s each, no network).
- `desolate clone`'s hint teaches `domain create --repo`.

## `desolate notify`: what needs you, as a notification (decided on the Mac; tested on T1, seen on the M1)

It reads `desolate events` and shows a macOS notification for a push waiting for approval,
an offer, an agent setting orange or red, a refused bundle, and a push done, failed or
uncertain. An agent's words appear under its workspace's name ("dev/w1 says: ..."), made
printable, and reach osascript as an argument, never as script: a status message cannot
pose as desolate, or run anything.

## Performance: where the time went, and what was cut (measured on the M1, 2026-11-13)

Measured on a fresh stack with two repositories and a devcontainer:

| | before | after |
|---|---|---|
| a call to the root (`rootctl`) | 240 ms | 78 ms |
| `desolate list` / `offers` / `branches` | 0.45 / 0.63 / 0.43 s | 0.27 / 0.27 / 0.23 s |
| `desolate exec` into a devcontainer | 0.84 s | 0.34 s |
| `desolate editor` | 0.90 s | 0.42 s |
| a push's card on the approval page | up to 2 s | up to 1 s |

- **The root's CLI channel is kept running** (`rootctl.ts serve`, kept by start.sh like rootd):
  140 ms of every call was loading the root's code. A request is one connection to a socket
  only the root's ordinary user can open (the same user that ran rootctl before: nothing new
  can ask). The service says it took a request before running it, so the host never asks
  again the old way for something that may have run; it steps aside when the root's code
  changed under it, and the host then asks the old way, with the new code. (First cut: node
  closed a connection when the host half-closed it, and every slower operation's answer was
  lost; found by doctor.)
- **`exec` and the editor's terminals enter the devcontainer with `docker exec`**, given the
  environment `devcontainer exec` would give (remoteEnv and its probe of the user's login
  shell), worked out once when the container comes up: 20 ms instead of 300 to 400. Checked:
  the same environment, line for line, as the CLI's. Without that file, the CLI as before.
- **What was not cut:** a workspace from its domain's template takes about 20 s, of which the
  VM's boot is 10 to 13 s (Lima and Virtualization.framework) and the devcontainer CLI's
  `up` 6 s; every other step is under a second (`DESOLATE_PROGRESS=1 desolate up` prints
  each). The devcontainer needs the checkouts, so the two cannot overlap.

## Agents without tmux, and the factories (decided on the Mac; tested on T2, run on the M1)

**`desolate agent`** keeps a command running in a workspace (`workspace/agent-holder.py`: a
pty, a log that keeps the newest, a socket in the VM user's own 0700 directory) and attaches
the person's own terminal to it on request. v2 ran Claude in tmux, whose mouse mode gave
either scrolling or copy-and-paste, never both; here the terminal draws the stream itself, so
both are the terminal's own, and the replay puts recent output in its scrollback. Ctrl-]
detaches. `stop` interrupts the agent through its own terminal, twice (a signal to `docker
exec`'s client never reaches into the container), and kills only when asked (`--kill`, or
"y" at its question).

**What an agent prints, on the way to the Mac's terminal**, is filtered
(`shared/terminal-filter.ts`, for `agent attach` and for `exec` to a terminal): text, C0
controls, CSI and single-character escapes pass (a TUI draws); every OSC, DCS, APC, PM and
SOS string is dropped (OSC 52 writes the clipboard, iTerm2's OSC 1337 offers files, DCS feeds
tmux integration and sixel parsers). tmux used to stand there; the emulator is outside every
boundary. Checked on the M1: an agent's OSC 52 does not arrive, its colours do.

**`desolate factory issues`** (v2's dispatcher, in TypeScript on desolate's primitives):
labelled issues become workspaces `issue-<n>` on `issue/<n>`, up to `--max` at once, started
side by side, each with Claude kept running by `desolate agent`; statuses come from `desolate
events`; a push of `issue/<n>` opens a draft PR naming the issue (never the agent's words); a
closed issue's workspace is removed (its branch stays). Claude's credential is a domain
secret on the Authorization header to api.anthropic.com, as in v2.

**`desolate factory suede`** listens for pushes to a default branch (the pusher's event) and
asks the root which vendored suede dependencies changed (`suede.changed`: each `.gitrepo`
directory in the pushed commit, the files under it the push touched, a nested dependency's
files its own, the project's own `release/` excluded). An agent decides, per dependency,
whether the change belongs upstream, and prepares it on `upstream/<project>-<commit>` in the
dependency's checkout; the person pushes it. Run on the M1 against this repository's own
commit that vendored suede.nests.

**Found doing it:** an anonymous clone's mirror pinned `lfs.url` to the repository's address,
not its `/info/lfs` endpoint, so any public repository with LFS files could not be cloned
anonymously. containerd's CRI plugin listened on a random loopback port in every workspace,
which desolate forwarded to the Mac as a dev server: off. An offer made inside a devcontainer
was "from unknown": the container now carries its workspace's names.

## Workspace sizes: from the Mac, per domain, per workspace (decided on the Mac; run on the M1)

A workspace's CPUs, memory and disk come from, in order: `desolate up --cpus --memory
--disk`, the domain's (`desolate domain <d> size`), and the stack's defaults, which are worked
out from the Mac each time and stored nowhere (half its cores, 2 to 4; a quarter of its
memory, 3 to 8 GiB; 30 GiB), the old environment variables overriding them. The size used is
recorded in the workspace's plan, so `desolate list`, `up` and the dashboard say what each VM
has; bootstrap says what the defaults come to. Measured on the M1 (10 cores, 64 GB): defaults
4 CPUs and 8 GiB; a domain at 3 CPUs and 50 GiB, `up --memory 6g`: the VM had 3 CPUs, 5.9 GiB
usable and a 48 GiB root filesystem.

Disk is at least 30 GiB: every VM is cloned from a 30 GiB base and Lima refuses to shrink a
clone's disk. So the root's (20) and the git VM's (10) declared sizes had never been applied;
they say 30 now, which is what they always had.

## ssh-agent needs a relay in front of it (measured)

ssh-agent refuses any peer whose uid is not its own. The keyring runs as its own user so the
root's git cannot read a key, which means the root's git also cannot talk to the agent
directly. The keyring therefore relays each agent on a second socket, and filters while it is
there: a client may list identities and ask for a signature, and nothing else (no adding a
key that skips confirmation, no removing or locking keys). v2's keyring avoided a relay; v3
needs one, and uses it.

## The request channel is a spool in the shares, not a socket

Section 4.3 allows "a vsock or socket with a fixed, validated vocabulary" from a workspace to
the root. v3 uses neither: a workspace writes a request file into its domain's outbox, and the
root answers in the inbox, which the domain cannot write. Both shares exist already, so the
channel adds no network path and no device, works the same on every backend, and is enforced
by the host's shares. The cost: the root polls outboxes (virtiofs delivers no inotify events
across VMs), so a request is noticed within the poll interval rather than at once.

## Storage: the root mounts `domains/` whole, read-write

The spec's table gives the root read-only access to a domain's `repos/`. The root VM instead
mounts `~/.desolate/domains` once, read-write, so that a new domain needs no restart of the
root VM (a share cannot be added to a running VM). What keeps the root out of a domain's
repositories is `root/git.ts`, which refuses to run git anywhere but a mirror or a root clone,
and a test that plants a hostile domain repository. A read-only mount would be defence in
depth on top; it costs a root restart per new domain.

## A domain's new repository reaches new workspaces only

A share cannot be added to a running VM, and each mirror is a share. `desolate domain <d> add
--repo` therefore says that existing workspaces do not see the new repository until they are
removed and made again.

## Base image: one provisioning script, two routes

`release/image/provision.sh` defines what a desolate VM contains. On Linux,
`release/image/build.sh` runs it in a debootstrap chroot and writes a root filesystem, a disk
and a kernel (the sandbox has no route to Ubuntu's cloud images or Docker Hub, only to the
package archive). On a Mac, the Lima backend runs the same script on the first boot of a
digest-pinned Ubuntu cloud image and clones the result. Root and workspace VMs boot the same
image.

## On vz, a share is the host's files seen through each guest's own cache (measured on the M1)

Three things the first workspaces on the Mac showed, each measured by hand on Lima 2.3.0:

1. **Ownership as a guest sees it is not the host's.** A share's root can report uid 0 for
   a moment after it is mounted. A file root in the guest creates, or `chown`s, reports uid
   0 in that guest from then on, while on the Mac it stays the user's (the host writes as
   the Mac user whatever the guest asked). Mounting a share's tag a second time, as root,
   left parts of the first mount reporting uid 0.
2. **Two guests do not agree at once.** A workspace replaced a symlink in its outbox with a
   directory; the root VM went on seeing the symlink for about a second (reading through
   it gave "Invalid argument"), then saw the directory. A file replaced by rename (a refs
   list) can likewise look as it was.
3. **Any user of a guest that reaches a share can write it.** A file in a share reports as
   owned by whichever user of the guest last asked about it, so the guest's permission
   bits give that user the owner's rights: in the root VM the proxies' user (uid 995) saw
   `/desolate/root` as its own, created a file there and appended to a root clone's file,
   and both changes were on the Mac. Within a vz guest, Unix users separate nothing on a
   share; what keeps a user out is a directory that is not a share. (Workspace VMs do not
   care: everything in one is the domain's. The root VM does: next section.)
4. **What does not follow from (2):** a stale entry cannot lead the root anywhere new. A
   link is resolved by the root VM's own kernel, and only when that kernel sees a link,
   which `outbox.ts` then refuses (`O_NOFOLLOW`, and the descriptor's own path). An entry
   the root still thinks is the old directory is operated on as that old directory by the
   host, never through a link made since. Staleness costs a refusal, not a boundary.

What changed because of them: a workspace VM's git trusts every directory (`safe.directory
*`: its user, root and its devcontainer are all the domain's, and a devcontainer running as
root makes "root-owned" files in the checkouts); the root looks for an offered commit again
for about three seconds before saying it received nothing (`root/offers.ts`); a VM is used
only once every share in its spec is mounted as the spec says (`host/vm/lima.ts`).

## The qemu backend uses 9p, because Lima's virtiofs on Linux is not read-only (measured)

In the sandbox, a Lima VM on QEMU with `mountType: virtiofs` and a share marked
`writable: false`: root in the guest ran `mount -o remount,rw` on it and then created a file,
and the file appeared on the host. Lima starts `virtiofsd` with no read-only option (its
source says so: "read-only mode is not supported on the QEMU/virtiofsd side yet"), so the
read-only is only the guest's mount flag. That is exactly the boundary P5 says must not live
in the guest. With `mountType: 9p` Lima passes QEMU's `readonly` for such a share, and the
same attack fails (tests/v3/t3). So: **qemu uses 9p; vz uses virtiofs**, where the Mac
refuses the write (measured on the M1). A consequence worth knowing: 9p mounts a share once
per guest, so the "mount the tag afresh, read-write" attack does not exist there, while on
virtiofs it does and is refused by the host.

## The qemu backend's egress: QEMU's own `restrict=on` (measured)

Lima gives every QEMU VM the user-mode network and has no setting to restrict it. Lima does
run whatever `$QEMU_SYSTEM_<ARCH>` names, so desolate points that at a wrapper
(`release/host/vm/qemu-wrapper.sh`) which, for a workspace VM, appends `restrict=on` to the
user network and a `guestfwd` from one guest address to the link's socket on the host. The
wrapper refuses to start a workspace VM whose network it did not restrict, or one with a
second network, and the backend checks the running QEMU's command line after the start.
Tier T3 then tries, as root in the guest: the host by its gateway address and its other
addresses, the forge, the internet by address and by name, DNS, UDP; and again after
rewriting routes, flushing every firewall rule and choosing a resolver.

## Inside a VM with no interface, connections need somewhere to go (measured)

On the fake backend a workspace has only loopback. For a program's connection to reach the
redirect to the egress relay it must first be routable. A dummy interface would do, but the
sandbox's kernel has no dummy module; a default route through `lo` routes the connection but
the redirected connection never completes; `ip route replace local default dev lo` (every
address is local to loopback) works. Real VMs have an interface and a default route, and are
not touched. None of this is a boundary.

## git-lfs: `lfs.url` outranks `remote.<name>.lfspushurl` (measured; a bug the tests caught)

The root clone sets `lfs.url` to the mirror (so downloads are offline and a hostile
`.lfsconfig` is ignored). With the push endpoint set as `remote.origin.lfspushurl`,
`git lfs env` showed the mirror as the endpoint for uploads too, and a person's push
"uploaded" its LFS object into the mirror instead of the remote, then pushed the commit: the
remote had a pointer with no object. `lfs.pushurl` is consulted first, so the root clone sets
that. A clone that is not pushable gets a push URL and an LFS push URL that lead nowhere,
and every mirror has a `pre-receive` hook that refuses everything, in a directory only root
writes: before those, `git push` in an unpushable root clone wrote a branch into the mirror.

## Secrets: TLS is terminated only for a secret's hosts (decided; tested on T2)

v2 ran every request through mitmproxy. v3 terminates TLS only where it must:

- each workspace's proxy (`release/root/proxy/proxy.ts`) still takes `CONNECT <name>:<80|443>`,
  applies the domain's rules, resolves the name itself, refuses internal addresses, and
  audits by link;
- a connection to port 443 of a host that one of the domain's secrets names is then handed
  to the domain's **secrets proxy** (mitmproxy 11.0.2, already in the image, with
  `release/root/proxy/secrets_addon.py`), together with the name and the address that were
  checked. That proxy accepts TLS for that name only, checks the upstream's certificate for
  that name against the root VM's trust store, connects to that address (nothing is
  resolved twice), substitutes, and scrubs the response;
- every other connection stays end-to-end TLS, and the domain's CA is never used for it.

The addon is v2's `addon.py` cut down to what v3 needs: v2's network rules, project
attribution by source address and per-project modes are gone (the workspace's proxy and the
link do those), and what remains is v2's code for proving a destination, the allowlist,
header confinement, overlapping names and scrubbing. Attribution comes from the header
`proxy.ts` puts on the tunnel it opens; a workspace's own bytes begin inside the tunnel.

One secrets proxy per domain, started when the domain gets its first secret and when one of
its workspaces starts, stopped when it has none. If it is not running, connections to its
hosts are refused, not passed around it.

Not carried over from v2 yet: switching a secret off for a while (`off`, `until`), the
self-test fixture, TLS passthrough lists, and trusting the CA inside a project's
devcontainer (v2's `release/proxy/container/install-ca.sh` and `trust-proxy-in-builds.sh`, at `4f32c77`): the devcontainer
itself is not started yet.

## The editor's gate runs in the workspace VM, and that is not a P5 exception

Each workspace runs VSCodium's server (the pinned `reh-web` build, baked into the image) on
its VM's loopback, with v2's `editor-gate.ts` in front of it, also on loopback. The host's
forwarder listens on one port (31581, `DESOLATE_EDITOR_PORT`) for every editor and carries a
connection to a VM's gate only if it named that workspace's editor hostname. The editor's
two in-VM ports are never forwarded as dev-server ports.

The gate (Host, Sec-Fetch-Site, Origin, and a sandbox for checkout files opened as pages)
protects a workspace's own editor from other pages in the person's browser. A workspace
that removed its own gate would expose only itself, so the gate can live with the editor.
What separates workspaces from each other, which name reaches which VM, is decided on the
host. The connection token stays, as a second lock behind the gate; the host reads it from
the VM to print the address.

Workspace trust is off in the workspace editor: the VM is the boundary (P1), unlike v2's
outer editor, which ran on the trusted side.

## The devcontainer: the CLI in the VM, the spec unchanged, the VM's network (tested on T2)

Section 4.2's shape A. `release/workspace/devcontainer.ts` runs `devcontainer up` in the
workspace VM against the checkout's own spec, with the VM's own dockerd, and adds through
`--override-config`:

- `/workspaces` mounted at `/workspaces`, and the checkout's own path as the folder. A
  domain clone borrows the mirror's objects by absolute path and its worktrees name each
  other by absolute path, so git works in the container only if the paths are the VM's.
  The mirrors are mounted read-only at their own path for the same reason;
- `--network=host` for a single-container spec. The container's traffic then takes the
  VM's one way out with nothing more arranged (measured: the VM's docker daemon's own pulls
  go through the workspace's proxy too), and a dev server in the container is a listener in
  the VM, which is what the forwarder publishes. A container on a docker bridge of the VM
  (compose services, a plain `docker run`) also goes out the same way: the redirect is in
  `prerouting`, and the stub resolver now answers on every address of the VM;
- the trust store that holds the domain's CA, by environment (`SSL_CERT_FILE` and its
  relatives). Tools that read only their own store (Java) are not covered;
- desolate's own CLI and the VM's node, so `desolate offer` works whatever the image has.

Nothing in a spec is refused. `updateRemoteUserUID` (the CLI's default) makes the
container's user own the checkouts. The editor's server runs in the container when it is a
glibc container on the VM's network (it is a glibc program), so its terminal, tasks and
language servers see the project's toolchain; otherwise in the VM, with a terminal that
enters the container. The gate always stays in the VM.

A docker daemon runs only where one is wanted. In a real VM `docker.socket` is started, so
the first `docker` command starts the daemon; on the fake backend the host starts it when a
checkout has a spec. (Measured the hard way: with a daemon in every workspace, the real-VM
tier's third VM was killed for memory in the 8 GB sandbox.) A workspace's size was 2 CPUs
and 4 GiB, with `DESOLATE_WORKSPACE_CPUS` and `DESOLATE_WORKSPACE_MEMORY_MIB` as the one
knob (question 9; since answered: "Workspace sizes", below).

Not done: the environment is not frozen and features are not pinned; no templates (C3) or
caches (C2, C4), so each workspace builds its own environment; compose specs' ports are not
forwarded. Features and compose are untested: the sandbox has no registry. The tests build
their image inside the VM from the VM's own files (`tests/v3/lib/devimage.sh`).

Since (2026-11-13, on the M1; `HANDOFF.md` 2f): templates and caches exist, and a compose
spec's primary service is given what a single container is given, but for the network. Its
network stays its own, because its services find each other by name; the VM reaches into it
through a relay in that service (`svcnet.ts`, on a unix socket in `/run/desolate`), and wsd
mirrors its listeners and its `service:port` forwards onto the VM's loopback (`bridge.ts`).
That changes no boundary: the service, the relay and wsd are all the domain's, the relay
answers only the VM's user, and the forwarder still decides on the host what reaches the
Mac, by the same rules. Considered and not taken: putting the primary service on the VM's
network (it loses its neighbours' names), and connecting to service addresses from the VM
(a server on the service's loopback, Vite's default, is unreachable that way, and addresses
change when a service is made again). Docker inside the devcontainer: docker-outside-of-docker
is the one to recommend; the VM is the boundary, so the devcontainer driving the VM's daemon
gives up nothing that docker-in-docker would keep, and docker-in-docker costs a privileged
service, a second daemon and a second image store (measured in `HANDOFF.md` 2f). In a
single-container spec it is worse: on the VM's network the nested daemon shares the VM's
`docker0` and hands out the addresses the VM's daemon does (measured: the same two
addresses given twice).

## The root UI: a state service that is told, and a dashboard that asks for nothing

Section 4.8's requirements, and how each came out:

- **One state service in the root** (`release/root/stated.ts`) holds the state and pushes
  it over an event stream. The dashboard draws from the stream and spawns nothing.
- **It cannot see the host, and cannot ask.** Which VMs run, forwarded ports, each editor's
  address, a start's phases: only the host knows, and no VM may open a connection to the
  host. So the host's daemon dials in (through the VM layer, as it does for a proxy) and
  tells it, with a token the host installed as root.
- **A VM gets no file events for a share** (virtiofs and 9p deliver none for another
  writer's changes). A status set in a workspace is a file changing in a share. The host
  does get events for it, so the host's daemon watches the status files' directories and
  nudges the service. The service also looks once a second, which costs a few small reads,
  so that a missed event is late and not lost. (Since #258: every 10 s, and each input has
  its event, listed in stated.ts; the host also watches each repository's list of branches
  in the outbox.) "Not by polling" is therefore true of the
  path that meets the budget, with a slow net under it.
- **Actions.** The dashboard queues a request; the host's daemon collects it and runs
  desolate's own CLI with arguments it builds itself from a fixed list
  (`release/shared/actions.ts`). The root VM never hands the host a command line. This is a
  new direction of control (root VM to host), limited to: start, stop, up, fetch, create a
  domain, add a repository. None of them can push.
- **Push.** From the dashboard it is a `git push origin` in the root clone, which waits for
  `desolate approve` on the host like any raw push. The dashboard raises no dialog.
- **Budgets** are asserted on the fake backend. Two things were needed to meet "state shown
  within 300 ms": the daemon keeps a few connections to the service open ahead of need
  (opening one costs an exec into the VM), and an answer is taken as complete at its
  Content-Length (the relay that carries a connection into a VM holds it open until the
  caller closes, half a second with socat). (Since 2026-11-23 the service is dialed when
  asked, a dial being 8 ms: "The rationing goes", below.)
- **It is a page, not an extension.** See `spec-progress.md`.
- **On the Mac (vz)**, measured on the M1 with five workspaces running: `/state` through the
  forwarder in 1.7 ms (median of 6; one of 92 ms), against the 300 ms budget; a status a
  workspace set reached the event stream 587, 55 and 46 ms after the command that set it
  returned, against 1 s.

## Timings in the sandbox (TCG, no KVM), for scale only

Tier T2 (52 tests, the fake backend): 3 minutes 15 seconds. Tier T3 under software emulation:
about 3 minutes to boot each VM, about 20 minutes for the tier. These say nothing about a
Mac, where a VM boots in under 10 seconds.

## The audit of 2026-11-16: spawn, issues, the forwarder, the root's word (audited; fixed)

After a night of dogfooding, four reviewers read everything changed since `863ec4b`
(workspaces starting workspaces, issues offered and published, the port forwarder, git in
workspaces, the dashboard's new routes, events and stats, the recipes), each given the code
and the threat model, not the author's conclusions. What they found, and what was done:

| Finding | Severity | Fix |
|---|---|---|
| A silent socket piped to a port's only listener before any name was read: a later request naming another workspace reached it, with that workspace's cookies | high (new that night) | nothing is piped before its first bytes name a workspace; silence is closed after two minutes (T2 03) |
| An HTTP request whose line never ended within 16 KB sniffed as raw and routed with no name check | high (old) | what starts like HTTP is HTTP; unparseable names no one and is refused (T1 sniff, T2 03) |
| VM names: a 40-bit hash; a colliding name made `up` destroy another domain's VM | high | `up` refuses an existing VM name before creating anything; the root refuses one any domain uses |
| The host acted on the root's plans and records as given (domain, VM) | high | `vouched()`: domain, workspace and the host's own VM name, in up, stop/start/rm/close, agent, reconnect (T1) |
| `desolate issue publish` wrote root-supplied fields to the tty | high | shows the checked draft; provenance must be two names, and is called the root's account |
| No limit on spawns: one domain could start ~30 VMs a minute | medium | no fixed limit (the person's choice), but the Mac's memory: 85% at most; three in flight per domain (T1) |
| Two Markdown regexes: 15 s and 7 s on a line of blanks | medium | rewritten: 7 ms and 2 ms (T1) |
| A publish reported failed after GitHub made it invited a second | medium | URL matched case-insensitively; a digest record and a lock on the host; the root marks published only the approved text |
| Replay after a daemon restart; close authority by name; `--name template` | low | used signatures on disk; the parent's key fingerprint in the record; the name reserved (T1) |
| Events capped across domains; queued actions evicted; `tkn=` could reach a domain's events; gh's token for another host; reviewer output echoed as desolate's words; `::1` not held | low | each fixed |

**A second review, of the fixes themselves,** found more, one of it older than all of this:

| Finding | Severity | Fix |
|---|---|---|
| The dashboard, editors and approval page were held on 127.0.0.1 only; Chrome tries ::1 first for `*.localhost` (measured), so another macOS user on `[::1]:<port>` would get their addresses, tokens in them, and could approve a push | critical (old) | held on both, or served on neither; doctor fails; `ui` and `approve --web` refuse to print a token address. Measured: while both are held, another process can bind neither, and a wildcard listener gets no loopback connection |
| On a raw port, a long HTTP request naming no one was demoted to raw and reached the port's owner | high (introduced by the first fix) | only a short line that merely looks like HTTP is demoted |
| A burst of spawns passed the in-flight and room checks together; the room check failed open | medium-high | counted in the check's own step; room counts spawns under way; not known is not room |
| The root's records still taken as given at three sites (the daemon's register at start, agent list, a domain's CA) | medium | `isOwnVm()` at each |
| Anyone could teach the forwarder a port was raw (and so reserved everywhere); silent sockets capped at 512 newest-refused | medium | no learning from traffic (`DESOLATE_RAW_PORTS` instead); undecided bytes closed; the oldest waiting is dropped |
| A gh killed by its timeout forgot the attempt; a recorded page refused instead of re-sent; ledger writes racing | low | kept as not known; re-sent; one lock; `spawn-used.json` written by the daemon only; `up` destroys only what it made |

**A third review** found the second round's own gaps:

| Finding | Severity | Fix |
|---|---|---|
| `desolate git` printed its token address unchecked; `ui` and `approve --web` passed when the daemon did not answer; tokens outlived a squatted `::1` | high | one fail-closed check (`tokenAddressesSafe`, on a cheap `editor` op); page tokens retired when `::1` is found held |
| A silent socket on a known raw port still went to its owner, and a browser's request sent on it later with it (a T2 run caught it: an `lsof` blocking the loop ended a 400 ms sniff before bytes already sent were read) | medium | the owner gets its client, but the client's first bytes are read first: HTTP or TLS closes both ends; `lsof` runs in the background |
| Spawns were never counted as ended (a regression of the second round): after three, a domain could start no more | medium | fixed; T2 16 |
| A domain's limit ignored spawns under way; a `::1` error other than in-use left a port forwarded; status read paths from the root's records; a stale lock could be taken twice | low | each fixed |

**A final review** of the third round found nothing above medium:

| Finding | Severity | Fix |
|---|---|---|
| A raw port's server greeting a silent client with an HTTP response: a browser's preconnected socket would read it as the answer to its next request, a page at another workspace's origin (same host, so its cookies) | medium | the greeting is looked at before any goes on: one with `HTTP` in its first 5 bytes is closed (Chrome takes no other answer on these ports: HTTP/0.9 is refused off 80 and 443). T2 03, with the greeting in two pieces |
| Retiring the tokens missed the dashboard's (the root keeps a copy, so a later daemon took the old cookie) and every editor's (made once, kept for good) | medium | `host/retired.ts`: the time of the retiring is kept; the dashboard and each editor are refused (503, with the fix) until their tokens are made again, by bootstrap, or for a stopped workspace by its next start. T1, and T2 03 end to end |
| A raw client that left at once still got a connection to the owner; a cut-off request line or TLS start went to the owner; a fresh publish lock could be taken as stale; signatures in an older `spawn.json` lost on the CLI's next write | low | each fixed |

**A review of those fixes** found two more, both fixed:

| Finding | Severity | Fix |
|---|---|---|
| An editor's token was judged by its file's time in the VM against the Mac's clock: a resumed VM's clock behind kept its editor refused through every bootstrap, and one ahead kept a token made before the retiring | medium | the retiring's own number, copied beside each token made after it (`token.epoch`; `ui-token.epoch` for the dashboard's, written only once the root has its copy); each retiring's number larger than the last, whatever the clock did |
| The greeting check knew Chrome's reading only; Firefox also takes `ICY ` after white space (from its source; not tried) | medium | refused too. Nothing of a greeting goes on while it could still become either (`greetingIs`, with a table of cases), so a short honest one (`raw:one\n`) goes at its first byte. Safari not looked at |
| The cut-off check refused a decided raw head starting 0x16 (a MongoDB hello, 1 in 256 lengths); a VM's older wsd reports no mark; a partial bootstrap marked the dashboard served | low | only an undecided head; asked directly; marked after the root's copy |
| Three publishers at once could still both pass the stale lock | low | not fixed: three at once, from one person's pages |

**What does not hold, said plainly.** The root's ordinary user, if a domain ever took it
over, still writes every domain's checkouts and passes on the dashboard's clicks (starting
and stopping workspaces). What the signing and `vouched()` now guarantee is narrower: it
cannot forge a workspace's spawn or close, and cannot point the host at another domain's VM.
The docs said more than that; they say this now.

**Checked and found sound** by the reviewers: the v2 signature (unambiguous bytes, HMAC with
`timingSafeEqual`, freshness), every argument reaching the host as an argv element (no `--`
or leading `-` gets through the validators), keys on tmpfs in the VM only, the approval
page's issue token over the exact digest with no TOCTOU, the Markdown preview building DOM
nodes only, the dashboard's POST routes behind the cookie, Host, Sec-Fetch-Site and custom
header checks, per-domain stats and events (each domain sees only its own), and
`git-urls.ts` reaching only the domain's own mirrors.


## The audit of 2026-11-20: the whole stack, by six reviewers with one area each (fixed, and what is not)

Six reviewers, each given the threat model and one area only (the push path; what the root
takes in; what a workspace or the root can make the Mac do; the network and secrets; the
dashboard and its sign-in; the git VM and the editors), none told what another found. Each
finding below was checked against the code before it was fixed; the ones marked "not fixed"
are left for the owner, with what would close them.

| Finding | Severity | Fix |
|---|---|---|
| The root's ordinary user could replace a domain's `repos/` (or a cache, an outbox, a mirror) with a symlink to any folder of the Mac's: the next workspace started mounted it writable, in a VM where anything runs | high | `host/vm/shares.ts`: every share under desolate's home is a real directory reached through no symlink, asked before a VM is made and before every start (Lima resolves a share at each start). T1 `shares.test.ts`, with a control. The time between this check and the VM process's own look: closed by the sandbox profile (below) |
| `desolate push --expect <commit>`: the host signed whatever approval text the root prepared, never comparing it with what the person typed: a root user taken over could name another commit under the same branch | medium | `host/push.ts` `approvalDiffers`: the repository and branch typed, and the commit named, or nothing is signed |
| The terminal filter passed a C1 control right after ESC (`ESC C2 9D` is OSC): everything it drops came through behind it, for `agent attach`, `exec` and the phone's agents page | medium | to the state that reads a C1, as in text; in-source case |
| The git terminal's output was not filtered: concealed text (SGR 8) in a commit hid a line of a diff from the person reading it | medium | through the same filter as an agent's terminal |
| A link to the git page with `domain` and `branch` checked that branch out in the person's clone with no click, from any page | medium | the page says what it would do and waits for a click |
| `secret import --in-place` wrote a temporary file at a guessable name beside the .env, through a symlink a workspace could plant, to a file of the Mac's; a symlinked .env was read and written back | medium | a new random name, `O_EXCL | O_NOFOLLOW`; a symlinked source refused |
| A program in a VM writing without end grew a string in the host's daemon until V8 refused it, and the throw stopped the daemon | medium | `run()` keeps at most 192 MiB of each stream, then stops the program and says so |
| The pages port held by another program on 127.0.0.1 (not only [::1]) did not retire the tokens | medium | it does, as for [::1] |
| Under an allowlist, the root proxy checked the CONNECT name only: a workspace could name an allowed CDN host and then speak TLS (or HTTP) to another site the CDN serves | medium | the first bytes' name (TLS server name, or Host) must be the host checked. Not closed: a Host inside TLS that differs from its server name (domain fronting proper), which only a CDN can refuse while TLS stays end to end |
| The secrets proxy read any body whole, without a limit; the proxies' audit logs grew without end, and a full disk made the next audit line throw and stop a proxy | medium | bodies over 256 MiB refused (a larger download through a secret's host now fails, closed); logs rotated at 64 MiB; an audit write never throws |

**Not fixed: for the owner, with what would close each.**

- **Shares the root can rename: closed the same day, by the sandbox profile.** The share
  check above runs, then Apple's VM process opens the path again when the VM starts. Measured
  on the M1 (Lima 2.3.0): a loop flipping a share between its folder and a link won 3 of 4
  starts, and one swap just after Lima's own checks won every time; the VM then read and
  wrote a folder of the Mac's, or read Lima's private key. Apple's VM process opens a share by
  a sandbox extension that Lima's host process issues for it, so whatever that process may
  hand out, a VM can be given, with all that is under it. Now every vz VM's host process
  starts under a profile (`host/vm/lima.ts`, `profile`) that lets it issue an extension for
  nothing but its own shares, each at exactly its path (named from desolate's home, never by
  following the share) and with exactly its access: a swapped share is refused ("Failed to
  issue sandbox extension ...") and the VM does not start. Two broader profiles came first,
  denying files by place; independent reviewers found a hole in each (a share swapped to the
  VM's own Lima directory, where desolate reads its ssh settings, or to a readable folder
  outside the denied places), because what the process could open, a VM could be handed. T4
  tries a folder of the person's, a writable one outside /Users, and the VM's own Lima
  directory, beside a control (the same swap, Lima unconfined, reads the Mac's folder). Not
  covered: the qemu backend (Linux), and `sandbox-exec` is deprecated by Apple, though it
  ships (macOS 14.5 here); doctor says so if it ever stops working.
- **Cookies are the tokens, and cookies ignore ports: closed the same day, by a page key.** A
  browser sends a name's cookies to every port of that name: any program on the Mac that
  listens on a loopback port, given a browser that visits `desolate-approve.localhost:<its
  port>` (any web page can send it there), was sent all three pages' cookies, and with them
  could approve a push waiting. Now each page's credential is two parts
  (`shared/page-key.ts`): the cookie, and a key the page's own script keeps in its origin's
  storage (scheme, name and port) and sends as `x-desolate-key`, which a page at another port
  cannot read. Both are derived one way from the page's token: the cookie is no longer the
  token, so a cookie that leaks cannot sign in (`?tkn=` takes only the token) or be turned into
  the key. A sign-in answers with a page of the origin's own that keeps the key and goes on.
  T1 and T2: the cookie alone, from the page's own origin, opens nothing; with the key, it
  does. The first bootstrap with page keys makes the three page tokens again
  (`retired.ts`, `remakeForPageKeys`): before, each cookie was its token, so a browser that
  signed in then would still send the token itself to any port, and with it anyone could sign
  in and be given the key (independent review). Sign in again once, `desolate ui --open`.
  Still open: a program that holds a page's own port while the daemon is not running is that
  origin, and could serve a script that reads the key (the daemon retires the tokens when it
  finds the port held); and a program on another port can still overwrite the page's cookie
  (`Set-Cookie` for the same name), which signs the person out, though it cannot make one that
  works.
- **Secrets with no header named are substituted everywhere, the body included.** A workspace
  can then have the service itself hand the value back changed (a model asked to spell it
  backwards; an API that fetches a URL the workspace names, with the key in it), past the
  scrubbing, which knows the value only as it is. Closing it: no secret substituted in a
  request body unless the person says so for that secret; the import presets naming each
  service's header (Gemini's `x-goog-api-key`, Tavily's `Authorization`).
- **What a push carries beyond its commit is not in its approval: closed the same day (#165).**
  The LFS objects and the pack the pusher sent came from the root's request: a root user
  taken over could add objects to an approved push, uploaded under the write key. Now the
  reviewer makes the pack (`root/reviewer.ts`, `prepare`: the objects the commit has that the
  remote's branches do not, each compressed by the reviewer's git itself, `--no-reuse-object`)
  and keeps it by its sha256, and lists the LFS objects its new blobs point to. The HOST puts
  the pack's sha256 and the LFS ids' digest in the text the person signs (`shared/approval.ts`,
  v3: the root's user writes neither). The pusher takes the whole pack, and every LFS object,
  before it sends a byte: the pack only if it hashes to the approved one, an LFS object only if
  it hashes to its name and is on the approved list.
  Two independent reviews of the first version found two ways round it, each now a test:
  - It forwarded the pack as it came, holding back its last 32 bytes until the hash was
    checked. But any stretch of what arrives can be a whole pack of its own: the root's user's
    own pack, whole, with 32 bytes after it, went whole to the forge, which took it before the
    hash was checked (T2 04 sends exactly that; run against that pusher, the branch moved).
  - The reviewer's pack-objects copied each object's compressed bytes as the root's user sent
    them. zlib's choices (a stored block's padding, its tables) and a delta's form are not the
    object, so they carried bytes of the root's user's choosing inside the approved pack, to the
    forge's own pack store (shown with git 2.39 by the review). T2 04 stores an object
    uncompressed in the root's clone: a pack that reuses it carries its bytes as they are
    (the control), and the reviewer's does not.
  Left open on purpose: the LFS objects go up before the branch's swap, as they must (the
  remote never has a pointer without its object), so a push the forge then refuses leaves
  approved objects there, and nothing else. The reviewer's repositories still grow with what
  the root's user submits, as before.
  The same change closes the other two items. The approval page lists the files a commit
  changes that the net change does not show, shows each commit's diff, and offers to push the
  commits squashed into one. The squash is the reviewer's commit: the last commit's tree, on
  where the branch leaves the remote's history, with the last commit's author and dates. The
  approval names it, and `squashes:` the reviewed one. And a push that replaces the remote's
  branch is signed only once the person confirms the replace apart from Approve: the branch's
  name typed on the page (the host refuses the click without it), `--replace` for `desolate
  push`, `replace <branch>` typed at the terminal (before Touch ID too). The keyring files a
  signed text only if it answers its own challenge: the same repository, branch, onto and
  nonce, and `squashes`, or else `commit`, the challenge's commit (that `commit` is a squash
  of it, the keyring cannot check: the host's signature vouches for it). The page signs only an
  account it listed, and its Approve arms only once that account is on it. A push the reviewer
  cannot describe can no longer be approved at all.
  Two more independent reviews, of the whole change (one trying to break it, one against this
  repository's own rules), found nothing that sends the forge anything unapproved, and gaps in
  what the person is shown, in the tests, and in the root's resources, all fixed before it
  merged:
  - **Shown.** The terminal cut its account at 300 characters, so a header warning could push
    "changes what runs on the forge" off the end: now a line each, the forge's files and the
    warnings first. Only the first 50 commits' headers were read, and a signature, a mergetag
    or an encoding was taken as git's own: now every pushed commit's, and anything but the
    four every commit has is warned of with its size. A single commit's message was shown
    nowhere, and each commit's diff gave the newest 50 under "cut at 256 KiB": now each commit
    whole, a single one too, first to last, cut with its reason, and a warning when it could
    not be made. The squash's dates were not shown, nor anything of it in the terminal: now
    its message, who it names and when, read back from the commit git wrote. A file name with
    a newline was listed as two.
  - **Tests.** The recompression had no test; the checks that something is not on the forge
    had no control; the case of an LFS object sent but not on the list was refused by the
    digest, never reaching the check it named; an in-source test of an undescribed push could
    not fail. Each now has a test with its control.
  - **The root's resources.** Every summary recompresses a push twice, and the root's user
    could have the page ask again and again: now one account at a time, each kept by the push
    and the remote's branches (an hour since last asked), git's pack memory and threads
    bounded, and the work ended whole, git and all, when its asker goes.
  - **After a squash.** The command printed to carry on came from the root's ordinary user,
    which could print any: now the host prints it, from the text it signed. A plain rebase
    made copies of what a merge brought in: now `--rebase-merges`.
  A fresh review of those fixes found the header check still open: a second `committer`
  line, or a line continuing the first, passed `fsck --strict` and `receive.fsckObjects`,
  and was taken as git's own by its name. Now the four are matched as git writes them, in
  order, once, and every byte after them is extra (T2 04 pushes exactly that commit's
  account). It also found the lock and the kept summaries cleared at each restart of the
  reviewer, which the root's user causes at will (now kept), two races in the lock, and a
  single commit's message unseen when its change was too large (now its message is shown,
  without the diff).
- **Tokens in a command line.** `desolate approve --web --open`, `git --open` and
  `editor --open` pass the page's address, its token in it, to `open`, whose arguments any
  user of the Mac can read in `ps`. Closing it: open them through a one-time sign-in code, as
  `desolate ui --open` does, after checking how each browser marks such a navigation.
- **The root's availability.** One domain can keep rootd busy for hours (a fetch whose helper
  outlives its timeout; many bundles; a million tiny blobs, each a process). LFS objects are
  copied before they are checked, and kept when nothing references them. A domain can name
  another domain's commit (by its id) in its own branch in a shared clone. None of these
  pushes anything; each makes the stack slower or mislabels whose work it is.
- **Smaller ones:** a workspace listening on a port the person's own Mac service holds on the
  wildcard address shadows it on loopback; an editor's name outlives its workspace (a service
  worker left by a compromised one could serve the next workspace of the same name); a slot's
  or editor's page in a popup over the approval page could take a click; wildcard secret hosts
  accept public suffixes (`*.github.io`).

## The limits effort: timers became liveness, cut lists became pages (decided on the Mac, 2026-11-21; tested on T1, T2 and T4)

A triage of 2026-11-20 found 483 hard-coded limits in `release/`. Most were not decisions:
a layer bounding something it had not designed (a list cut where it should page, a timer
where the person is waiting anyway, one number copied into five files), and often the cut
fed a count, so the stack stated numbers it had not counted ("All 200 commits"). The rules
each limit was put to (four questions, R1 to R9) and the shared contracts that replaced
them are [limits.md](limits.md). The contracts and fifteen tickets (#171, #173 to #187)
landed together as #196 (`422ef78`); the triage (`docs/v3/limits-triage.md`) and each
ticket's row-by-row table (`docs/v3/limits/NN-*.md`) are in that commit, and were deleted
after it. What the review of the merged result left is #206 to #213. Each ticket had a
fresh-context review that tried to break it; what they found is below with what it changed.

**The reviewer's account and the approval page** (#173, #174).
- **No deadline.** `review-ask` ran under `timeout 95`, inside the page's 90 s and the host's
  120 s, around git timeouts of 2 to 30 minutes that could never fire: a large first push
  could never be approved. Now the account is a stream (`shared/review-account.ts`):
  progress lines, again every 5 s while nothing changes, then one answer. A write to an
  asker that has gone fails, and the reviewer's process group is ended; that is how the
  reviewer knows it is still wanted. Accounts are made one at a time, in a queue (a lock held
  by a live process), and kept an hour since last asked, the newest 64.
- **Counted, never cut.** Commits, files and the files the net change hides are `Listed`,
  forge-sensitive files first; a diff is pages of bytes (1 MiB), of the net change, one file,
  or one commit whole. The terminal and the page show every warning, every file that changes
  what runs on the forge, and the whole squash message (it is signed). `root/reviewer.ts`
  (1,446 lines, five jobs) is four modules of one job each.
- **Hard bounds kept, against the root's ordinary user:** a review bundle is refused only when
  twice its size is more than the reviewer's disk has free (a repository over 2 GiB can now be
  reviewed: the forge's push size bounds the pack, not the history); at most 10,000 refs in a
  bundle (`git fetch` matches each refspec against every ref); the first 200 commits at the
  boundary of what is new are tried (`EDGES`: each is two walks under the one lock, and the
  root's user shapes the boundary); a squash is not offered when a name is over 80 or an email
  over 254 (RFC 5321). Pack threads, window, big-file threshold and the kept packs' disk are
  settings (`reviewer.*`), from the root VM's size. On the host, `ASKING_MOST` (4 questions at
  once) and `LISTED_MOST` (32 pushes with an account): each listed push was a process in the
  root and on the Mac.
- **Signed only as shown.** `/approve` signs only with the token over the account the host
  holds now (`shownToken`): a push that leaves the list and comes back with another account
  signs nothing for the one the page drew.
- **Found by its review, older than the effort:** a review bundle's objects were never checked
  (a fetch from a bundle ignores `fetch.fsckObjects` before git 2.46; a commit with a NUL in its
  message passed). `submit` now runs intake's `bundleRefusal` first.

**What an approval lives by** (#175). A clock is kept only where it stops a named attack.
- A raw push's challenge lives while its asker holds its connection to the keyring: when the
  process ends, however it ends, the kernel closes it and the keyring drops the challenge.
  Nothing has to notice a silence. Held a day, it gains the root's user a line on the approval
  page, which it could already have by asking every two minutes; at most 32 are outstanding,
  and a 33rd drops the oldest, telling its asker. `desolate push`'s challenge, which nobody
  holds, keeps 120 s.
- An approval must be claimed within 120 s (`APPROVAL.lifeMs`), on purpose: the root's user is
  the asker, and without the clock could keep a push it told the person had failed, and land
  it a day later; the host has no way to take an approval back. Once claimed it lives while
  the pusher's connection does, and the root's user must hand the push over within
  `handOverBy(bytes)`: the two minutes again, plus the bytes at 10 MiB/s (a 2 GiB pack: 5 min
  25 s). The review found the first version let a byte every 59 s keep a claim for days.
- Eight signatures: one for receive-pack, one for each `git-lfs-authenticate`. Uploads to the
  forge have no total, only `IDLE_MS` (60 s) while bytes are left; the forge's report after
  the pack keeps 30 minutes. The push lock is held by a live process, not for 5 minutes.
- **Proposed, not done:** a withdrawal of an approval, signed by the host (the root's user
  carries the request, so it could withhold an unsigned one). With it, neither the two
  minutes nor `handOverBy` would protect anything.
- **Measured** (git-lfs 3.3.0): its progress file gets a line per 32 KiB sent, so nothing
  written to it for 60 s is nothing sent for 60 s. With `lfs.activitytimeout=5`, git-lfs gave
  up on a stalled upload by itself only after 84 s, retrying; the pusher's bound is the one
  that says what happened.

**The dashboard's review** (#176). `rev-list --count`, then a page with `--skip`; every count
shown is the total, and a commit picked from any page is checked by git against the range. A
diff is pages of 256 KiB or 3,000 lines (what draws quickly), or one file's alone. Nothing in
it has a timer: closing the page stops git. The fetch a review starts runs to its end, since
killed mid-write it leaves ref locks in a clone every domain shares. An offer's LFS objects
are all taken (a silent cut at 2,000 had made a larger offer impossible), bounded by the
request's own 1 MiB. Left: the dashboard's review and the reviewer's account are still two
(the dashboard's runs in `stated`, the reviewer's as its own user); `review()` could answer
an `Account` and the dashboard read the same lines the approval page does.

**The root's mirrors and out-boxes** (#177). A domain is not trusted: every bound on what the
root reads from an out-box stays hard, named once, refused with `over()`, the bound and the
size. A mirror's fetch has no total, only `FORGE_IDLE_MS` (5 minutes of silence; `--progress`
makes git speak every second while bytes come), and ends when its asker goes. `refs.json` has
one reader (`refsOf`), one bound (4 MiB, over 16,000 branches at the longest name), and
answers it whole or refused: before, a silent cut at 5,000 refs led `git fetch --prune` to
prune every branch past it. The bundle check scales with the bundle (`checkMs`: a minute,
and a second a MiB). `suede changed` lists every dependency and file (it had checked every
file against every dependency, hours on a large commit). The review found a remote helper
outliving its fetch (one per fetch, stacked), a `refs.json` that was a dangling link read as
"nothing synced" (and so pruned), and doctor reading a timed-out `sudo -n true` as a pass.
**Measured** on the M1: `git index-pack --strict` of a 201 MB bundle's pack, 10.5 s
(19 MiB/s), so `checkMs` refuses only a bundle made to be slow.

**The request channel** (#178). A request is taken, then waited on with no deadline. Before,
every request gave up at two minutes ("Is it running?"), whether the root had never seen it
or was half-way through a large fetch, and a domain had 30 requests a minute in all, so a few
agents fetching in a loop had its offers refused.
- rootd writes `rootd.beat` from a thread of its own every 2 s, and `replies/<id>.taken`
  (`{ boot, doing }`) when it takes a request. The workspace waits while the beat moves, says
  what the root is doing after 10 s, and gives up only on 10 s of no beat (lock.ts's `BEAT`),
  saying whether the root had taken it. Either side on older code gets the old 2 minutes.
- The rate is gone. One domain is kept from slowing another by structure: the loop never
  waits on a request's work; each domain has a lane (one at a time, in order); fetches are
  coalesced per repository (one runs, one waits, every asker answered by a fetch that began
  after it asked); a root clone is worked in by one domain at a time. What is left hard is
  `MOST_HELD`, 50 requests a domain, which is what the root held of one domain before.
- **Measured** (T2 `24-requests`): a fetch held four minutes at the forge and thirty more
  asked meanwhile all succeeded with at most 4 upload-packs; another domain's offer during a
  flood of 20 slow ones took no longer than with no flood (the control). Left: fetches have no
  pace (a domain fetching in a loop fetches back to back), and a root rolled back to before
  the beat leaves a stale beat behind.

**Agents** (#179). The log stopped at 64 MiB keeping the oldest, so `agent log` showed stale
output for ever. It is now segments named by offset (none renamed), the oldest dropped past
`agent.logMiB` (a twentieth of the VM's disk unless set), the drop said by every read from the
start; an attach replays 2 MiB from the log, more than a terminal keeps (Terminal.app and
iTerm2 keep 10,000 lines). `stop` no longer kills 3 s after Ctrl-C: it asks, or `--kill`.
**Measured** (T1): 2.7 MB of `seq` under a 1 MiB most kept eight segments from a whole line,
the drop said, beside a control under its most.

**Bringing a workspace up** (#180). The host owns patience and sets no total: the VM's two
long steps say what they do when they begin and every 10 s, and the host stops one only
after two minutes of silence (a frozen VM, a lost ssh). Inside, idle bounds and `signal` (git
with `--progress`, 10 minutes; `devcontainer up`, an hour). The init lock is a share lock in
`/workspaces/.desolate/locks`, which an agent of the domain can write: safe, since what that
side can do with it, it can already do to the domain's `.git`. What the VM sends stays
bounded as a side not trusted: its bytes (`RUN_MAX`), its silence, what is kept of an error
(one file per workspace and step, overwritten: the daemon looks every 30 s), what is shown a
beat. The review found the first three as holes.

**The host's forwarding** (#181). The forwarder's decisions moved, unchanged, into
`host/forward.ts` (`daemon.ts`: 3,700 lines to 2,400). A link's connections are a setting,
`link.connections`: past it they wait their turn, then are refused with a 503 and the
setting's name (the 65th used to be destroyed in silence). The pages' port held a silent
client 400 ms, which failed a browser's preconnected socket; it is now 60 s, among the 512
silent sockets. A pusher log line over 1 MiB no longer stops every later push's event.
**Measured** on the M1: one carried connection was a `limactl shell` of its own, 83 MB and
2 MB for its ssh; so the default is an eighth of the Mac's memory at 85 MiB each (16 to 256),
and the top is the root's sshd `MaxSessions`, 1000. (Since 2026-11-23 a connection is a plain
ssh session, 1.5 MB: "The forwarder's way into a VM", above.) Left: multiplexing a link into one
session, which would remove the setting, needs a demultiplexer beside the root's proxy.

**The rationing goes, and connections in are counted** (#250, step 4). With a connection at
1.5 MB on the Mac (3.3 MB resident), 8 ms to open, and about 1.2 MB in the root VM with 200
held at once (3.9 GiB there; measured on the M1, 2026-11-23), nothing is worth waiting for:
the queue, the memory arithmetic and the dashboard's stock of ready sessions into the root
(five, kept for three minutes after the dashboard was used, against a dial of tens to
hundreds of milliseconds) are gone, and the state service is dialed when asked. A
connection is carried or refused at once. `link.connections` stays, 256 by default, and now
bounds each workspace twice, apart: its connections out, and its connections in (its dev
servers, its editor: never counted before), so that a flood one way does not starve the
other. The Mac carries 800 in and out of every workspace together, a fixed bound: under sshd's 1,000 sessions a connection (`MaxSessions`, in the root VM and every workspace VM), since every connection out and the dashboard's pipes ride the one control connection to the root VM, with room for the host's own sessions on it. Past
either, a request is answered 503 with `X-Desolate-Reason`, anything else closed, and
`desolate ports` and the log say so. A connection counts until its client's socket closes,
which every end of a pipe comes to (`carrying`, `daemon.ts`). The dashboard's own pipes to
the root's state service are not a workspace's and are not counted.

**The egress proxy** (#182). `net recommend` showed 60 hosts and printed a `net allow` for
those 60; following it, then `net enforce`, cut off the rest. Every host is now counted, and
the command allows exactly what is shown (`--all` for every one). The audit log is a series
(`audit-<n>.log`): every writer appends to the newest, the first to find it over its share
starts the next by an exclusive create, nobody renames (two processes rotating one file had
overwritten each other's), within `proxy.auditMiB`. A body through a secret's host is no
longer refused past 256 MiB (the 2026-11-20 audit's fix): it is held whole up to
`secrets.heldMiB` or the domain's `net hold`, and past that streamed, values taken out of a
response as it passes and a request naming one past the bound refused. The review found a
decompression bomb (nothing is now undone past the hold bound, held or streamed).
**Measured** against mitmproxy 11.0.2 by length, chunked, gzip, HTTP/2 and HTTP/1.0, each
beside the control without the proxy. Left: the bound is per request, not per domain; a
streamed request is decided by its head, so a value in its head reaches its own host before
a later name in its body refuses it; a streamed compressed response arrives decompressed.

**The host's calls to the root** (#183). A rootctl call is given up only after a silence,
`root.silentSeconds` (900, so nothing the old 15-minute total let finish is cut), and only a
whole line counts as hearing from the root: the review found that any byte would let the
root's user hold the daemon's calls open for ever. The calls nobody watches keep a total, by
operation (`BRIEF`), for the same reason. Every cut of another layer's output is
`because()`: the last ten lines and, when that is not all, the path of the whole under
`~/.desolate/logs/failures/`. Provisioning and the root-state carry have no timer: they say
each step, or stream to a file.

**The git VM** (#184). Its out-box is one exchange (`shared/git-out-box.ts`) whose bounds are
checked by both ends before any work, and every refusal is answered at once: a request over
the old 64 KiB had been removed unanswered, its push waiting 20 minutes, and the 2,000-object
count behind it could never be reached. A push waits for as long as its helper runs, and
Ctrl-C withdraws it until it is handed to the root. A shell whose tab closed is not ended: the
page offers it back. The review found two out-box names (a directory called `<id>.gone` or
`<id>.json`) that stopped the host's daemon, and every page with it.

**Settings** (#185). `desolate settings` stores the person's choices in
`~/.desolate/settings.json`; a setting read in a VM is written by the host, as root, to that
VM's own disk, and each side reads only its own store (the review found that code of the Mac's
running in a VM would otherwise read a store that VM's user writes). A value a setting does
not take is refused, never the default. The root VM is now sized from the Mac (a quarter of
its cores, 2 to 4; an eighth of its memory, 2 to 4 GiB) where it was 2 and 2 GiB on any Mac.

**Scripts and recipes** (#186). `recipes/issues.sh` read 100 issues, and took the 101st for
closed: measured against 120, the old recipe stopped three agents it should not have; it now
pages, and a list it could not read to its end does nothing. A root service that keeps
failing is restarted with backoff, 1 s doubling to 60 s (about 60 log lines an hour, not
1,800). An image without the editor is made only when asked (`DESOLATE_IMAGE_EDITOR=none`).
The shell copies of the slug rule are checked against `isSlug` on 3,000 names in three
locales: macOS's bash 3.2 takes `[a-z]` to match `é` under a UTF-8 locale, so they spell the
letters out.

**The shared helpers** (#187). A sorted `packed-refs` is searched by halving, so 5,000
branches (350 KiB, past the old 256 KiB, where no branch showed a commit) cost a few reads.
`run()` counts bytes, decodes once, and keeps one doubling buffer (a list of chunks had held
141 bytes per byte written a byte at a time). An action argument that is too long is refused,
never left out (a domain had been made without its title). `keepApart` no longer loops for
ever on `MY_API_TOKEN`, `MY_API_TOKEN_2`, `API_TOKEN`. Left: two keys can still make one
secret name against secrets the domain already has (`DB` and `DB_SECRET`); fixing it renames
existing secrets on re-import.
