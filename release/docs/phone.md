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

- **One domain's dev servers, when you choose it.** None, until you do:

  ```bash
  desolate phone dev <domain>     # this domain's dev servers, and no other's
  desolate phone dev off          # none
  ```

  Each server of that domain gets an address on the tailnet while it listens, from its
  domain's own block of sixteen ports (the first domain's `https://<mac>:9101` to `:9116`, the
  next one's from `:9117`, and so on, kept for good): `desolate ports` lists them ("on your
  phone"), and the dashboard on the phone links to them. The server sees what it sees on the Mac (its
  workspace's own name), and Vite's hot reload works through it. Sixteen at once; past that, a
  server has no phone address until one stops. One domain at a time, because on the phone
  every dev server has the same name (below). Choosing another closes every connection still
  open to the last one's, and takes its addresses off the tailnet. `desolate phone on` starts
  with none again.

What it cannot do: approve a push, open an editor, or open the git terminal. A push is
approved on the Mac, outside every VM: that stays the one step nothing else can take.

## Why it is safe to leave on

- **Only your devices.** Tailscale Serve names the tailnet user with each request; desolate
  refuses any other than the one `desolate phone on` recorded, before any token is asked
  for. A request with no user is refused: one from a tagged device, and one through Tailscale
  Funnel (which would put an address on the internet; desolate never turns it on, and you
  should leave it off for this Mac). Nothing reaches it from the internet: the addresses
  resolve inside your tailnet only. "Your devices" is every device signed in as that tailnet
  user: anyone your tailnet's admin, or your identity provider, lets sign in as you too.
- **The same tokens.** Each page opens only with its own token, as on the Mac. The phone's
  link is exchanged for a cookie at once, and the address bar keeps no token.
- **The agents page is the host's, on an origin of its own.** Typing into an agent runs
  something in its workspace. The dashboard is served by the root VM, whose ordinary user
  reads every domain's data; the agents page is served by the Mac's own daemon, the root never
  sees what it is asked, and the dashboard's script, on another origin, cannot call it. The
  phone sends every cookie of the tailnet name to every port of it, the agents page's token
  with them: desolate passes the dashboard its own cookie only, so the root never holds it.
  (The approval page is the Mac's for the same reason.)
- **Dev servers share one name on the tailnet, so one site.** A browser keeps one cookie jar
  for a name, whatever the port, and counts every port of it as one site. On the Mac each
  workspace has a name of its own (`*.localhost`); on the phone they have one. So desolate:
  - never passes the dashboard's or the agents page's cookies to a dev server, and never lets
    one set them. A dev server's answer keeps only the headers a page needs: no
    `Clear-Site-Data` (which would clear the whole name's cookies), no `Alt-Svc` (which could
    send its origin's requests to another port), and nothing is cached;
  - gives each domain its own addresses, never another's: an address is an origin to the
    browser (its storage, its service workers, what its pages may read);
  - renames each cookie a server sets for that server (its workspace and port, never the
    address it happens to have now), returns it to it only, and makes it `HttpOnly`, so no
    other dev server's page can read it. That hides it from the server's own page too: an app
    whose script reads a cookie its server set (Django's `csrftoken`, Angular's `XSRF-TOKEN`)
    breaks on the phone;
  - refuses service workers, which would stay with an address after it is given to another
    server, and clears an address's storage and cache in your browser the first time it
    answers for a server other than the last one it answered for there;
  - pipes a WebSocket on only once the server has switched protocols.

  **What a proxy cannot keep apart, and why one domain at a time:** a cookie a page's own
  script sets goes to every dev server of every domain the phone has reached, and any dev
  server's page can read it, change it, or set one under another app's name. A page left open
  can also send another domain's dev servers requests with their cookies (`SameSite` does not
  stop it: every port is one site), though not read their answers. Within one domain, that is
  what a domain already trusts; across domains it is not. So: one domain at a time; close a
  domain's dev-server tabs before you choose another; open a dev server whose pages you do not
  trust in a private tab. Only a name of its own for each domain on the tailnet (another
  Tailscale node for each, signed in by you) would close this: not built yet.
- **The dashboard and the agents page refuse any request another page starts,** a dev
  server's page included, and neither can be framed.
- **What the agents page shows is drawn as a terminal draws it,** through the same filter as
  `desolate agent attach`: an agent's output is never put on the page as HTML.

## What is left to you

- **Anything on the Mac can reach the loopback ports Tailscale Serve is pointed at** (the two
  pages and the sixteen dev-server addresses), as it can the dashboard's own, and can say it is
  any tailnet user there; the tokens are what open the pages, there as here. If another program
  holds one of those ports when desolate's daemon starts, Serve would send it your phone's
  requests, cookies and all: so if the phone is on, the daemon retires the pages' tokens (the
  agents page's too) and takes the phone off the tailnet; and `desolate phone on` and
  `phone dev` refuse while any of them is another program's. Find it and stop it
  (`lsof -nP -iTCP -sTCP:LISTEN`), then `desolate bootstrap` and `desolate phone on`.
- **`desolate phone off`** takes the pages' and the dev servers' addresses off the tailnet and
  forgets which domain's dev servers it reached. It does not stop `desolate notify --ntfy`, and the phone's
  cookies stay in its browser until the tokens are made again.
- **A lost phone:** remove it in Tailscale's admin console (Machines), which stops it reaching
  the tailnet at all; then, on the Mac, `desolate phone off` and `desolate bootstrap`, which
  retires the old tokens, and `desolate phone on` for your next phone. An unlocked phone with
  these pages open can type into any running agent, in any domain: lock it.
- **Notifications through ntfy** carry repository and branch names and what agents say. ntfy.sh
  (or the server you name) and anyone who knows the topic can read them, and publish to it:
  `desolate notify` refuses a topic shorter than 20 characters. Agents' words are always
  labelled as theirs ("dev/w1 says: ..."), and desolate sets each notification's title and the
  address a tap opens. Treat a link inside an agent's words as the agent's.
- **The certificate for your Mac's tailnet name** is logged in public Certificate Transparency
  logs, as every HTTPS certificate is: the name (`<mac>.<tailnet>.ts.net`) is public, though
  nothing behind it is reachable from outside your tailnet.
- **What an agent shows is the agent's.** Its terminal is drawn as it draws it, so it can draw
  anything, a prompt that looks like desolate's included. A push is still reviewed and approved
  on the Mac: a review on the phone is not the approval.
