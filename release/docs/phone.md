# desolate from your phone

Agents keep working on your Mac. When one needs you, your phone says so, and you can see
what it is showing and answer it, from anywhere your phone has a network. Over
[Tailscale](https://tailscale.com): nothing is opened to the internet, and only your own
devices can reach it.

## What you need

- **Tailscale** on the Mac and on your phone, signed in to the same tailnet, with MagicDNS on
  and HTTPS certificates turned on (the admin console's DNS page). Installing the Mac app needs
  an administrator of the Mac.
- **The ntfy app** on your phone, for the notifications ([ntfy.sh](https://ntfy.sh), or a
  server of your own). Optional: without it, the phone works, but tells you nothing.

## Turn it on

```bash
desolate phone on
```

```
on your tailnet, for you@example.com's devices only:
  dashboard  https://mac.tail1234.ts.net:8443/?tkn=...
  agents     https://mac.tail1234.ts.net:8444/?tkn=...
open each once on your phone: they carry their pages' tokens, so keep them to yourself.
Pushes are still approved here, on the Mac. desolate phone off takes both off the tailnet.
```

Open each address once on the phone (in Safari or Chrome there), and add each to the home
screen. The token in it becomes a cookie for that page; the address without it is then
enough. `desolate phone` says whether it is on; `desolate phone off` takes both pages off the
tailnet.

For notifications, pick a long random topic (it is the only secret an ntfy topic has),
subscribe to it in the ntfy app, and leave this running on the Mac:

```bash
desolate notify --ntfy https://ntfy.sh/desolate-$(openssl rand -hex 8)
```

It sends what `desolate notify` shows on the Mac: an agent asking for you (orange) or failing
(red), a branch offered, a push waiting for approval, a push done or failed. Tapping one opens
the dashboard. Claude, started by `recipes/claude.sh`, goes orange by itself when it stops to
ask you something (a permission it needs, a question), with its own words.

## What the phone can do

- **The dashboard**, laid out for a phone: what needs you, each workspace and its status,
  reviews with their diffs, starting and stopping workspaces. Pushing from it asks, as on the
  Mac, for your approval on the Mac.
- **Agents** (the second address): every running agent, its terminal as it draws it, a line
  typed into it, and the keys a phone keyboard lacks (Enter, the arrows, Tab, Esc, Ctrl-C).
  `desolate agent say <domain>/<workspace> -- <text>` does the same from a terminal.

- **Your dev servers.** Each server a workspace runs gets an address on the tailnet while it
  listens, from `https://<mac>:9101` to `:9116`: `desolate ports` lists them ("on your
  phone"), and the dashboard on the phone links to them. The server sees what it sees on the
  Mac (its workspace's own name), and Vite's hot reload works through it. Sixteen at once;
  past that, a server has no phone address until one stops.

What it cannot do: approve a push, open an editor, or open the git terminal. A push is
approved on the Mac, outside every VM: that stays the one step nothing else can take.

## Why it is safe to leave on

- **Only your devices.** Tailscale Serve names the tailnet user with each request; desolate
  refuses any other than the one `desolate phone on` recorded, before any token is asked
  for. Nothing reaches it from the internet: the addresses resolve inside your tailnet only.
- **The same tokens.** Each page opens only with its own token, as on the Mac.
- **The agents page is the host's, on an origin of its own.** Typing into an agent runs
  something in its workspace. The dashboard is served by the root VM, whose ordinary user
  reads every domain's data; the agents page is served by the Mac's own daemon, the root never
  sees what it is asked, and the dashboard's script, on another origin, cannot call it. (The
  approval page is the Mac's for the same reason.)
- **Dev servers share one name on the tailnet, so desolate keeps their cookies apart, as far
  as a proxy can.** A browser sends a name's cookies to every port of it.
  - The dashboard's and the agents page's cookies are never passed to a dev server, and a dev
    server cannot set them.
  - The cookies a server sets are renamed for that server (its workspace and port, never the
    address it happens to have now) and returned to it only, so a session cookie never reaches
    the next server given its address. They are made `HttpOnly`, so no other dev server's page
    can read them. That also hides them from the server's own page: an app whose script reads a
    cookie its server set (Django's `csrftoken`, Angular's `XSRF-TOKEN`) breaks on the phone.
  - **What a proxy cannot keep apart:** a cookie a page's own script sets goes to every dev
    server, and any dev server's page can read it, change it, or set one under another app's
    name. On the Mac each workspace has a name of its own (`*.localhost`), so this happens only
    on the phone, and across domains. Open a dev server you do not trust in a private tab.
  - The dashboard and the agents page refuse any request another page starts, so a dev
    server's page cannot make them do or read anything.
- **What the agents page shows is drawn as a terminal draws it,** through the same filter as
  `desolate agent attach`: an agent's output is never put on the page as HTML.

Anything on the Mac can reach the two loopback ports Tailscale Serve is pointed at, as it can
the dashboard's own; the tokens are what open the pages, there as here. (`desolate phone on`
points Serve at eighteen ports: the two pages and the sixteen dev-server addresses.)
