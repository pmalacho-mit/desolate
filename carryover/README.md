# v2 code that v3 has not ported yet

Each piece here is something v3 still lacks, kept with its v2 tests so that whoever ports it
has it in front of them rather than in history. Nothing here is shipped, run or type-checked:
imports point at v2 files that no longer exist, or at their v3 replacements by their old
names. All of v2 is in history at commit `4f32c77`, and on the `release` branch until v3 is
published there.

What v2 had and v3 has replaced is gone from here: completion (`release/completion.bash`),
the dispatchers and the suede factory (`release/recipes/`), status (`release/workspace/status`,
`desolate status`, the dashboard), transfer (offers, review, push and `desolate upstream`),
reading `devcontainer.json` (`release/workspace/devcontainer.ts`, `release/shared/jsonc.ts`),
and the editor's gate and held settings (`release/workspace/editor-gate.ts`,
`editor-settings.ts`).

| Here | What it is | Where it goes in v3 | What v3 has meanwhile |
|---|---|---|---|
| `proxy/addon.py`, `test_addon.py`, `settings.example.json` | v2's mitmproxy addon, whole | `release/root/proxy/secrets_addon.py` is cut down from it (proving a destination, the allowlist, header confinement, scrubbing, on/off and TTL), tested by `tests/v3/t2/07-secrets.test.ts` | Still only here: the self-test fixture (a known placeholder sent through the proxy to prove substitution and leak detection live; T2 proves them instead). TLS passthrough needs no porting: in v3 every host but a secret's is passed through by design (`release/root/proxy/proxy.ts`) |
| `proxy/install-ca.sh`, `trust-proxy-in-builds.sh`, `with-ca.sh`, `certificates.ts` | trusting the proxy's CA inside containers and their image builds | `release/workspace/` | The VM's trust store (`release/workspace/net/trust-ca.sh`) and the devcontainer's (`/desolate/ca` and its environment). Not image builds: a build step that talks to a secret's host (a private registry) fails TLS, so the install goes in `postCreateCommand`. Only a secret's host is ever signed with the CA, so public registries need none of this. Worth porting when someone needs a private registry during a build, and not before |
| `devcontainer/feature-pins.ts`, `.test.ts` | a devcontainer's features pinned to digests | the domain's environment, frozen once (move-to-vms.md section 4.5) | Features resolved by `devcontainer up` each time a container is made |
| `editor/extension/`, `model.test.ts`, `panel.md`, `extension-browser-test.sh` | the workspace-side editor extension: `localhost` addresses mapped to the workspace's own hostname, and its panel | `release/workspace/editor/` | The host sends a bare `localhost:<port>` on to the workspace serving it (`release/host/daemon.ts`), which covers a clicked link anywhere; `DESOLATE_DEV_HOSTNAME` in the devcontainer; `desolate ports`. What is left is the panel |
| `editor/editor.ts`, `.test.ts`, `appearance.ts`, `hosts.ts`, `git-codium.sh` | the editor's launch with its extensions from `devcontainer.json`, its appearance, its host names | `release/workspace/editor.sh` and `editor-*.ts` | The editor runs in the devcontainer, without the project's extensions preinstalled |
