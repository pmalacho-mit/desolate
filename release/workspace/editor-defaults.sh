#!/bin/bash
# The person's default editor settings, for this workspace's editor: the settings JSON on
# stdin (the host's, ~/.desolate/state/editor-defaults.json, host/editor-defaults.ts). They
# go in as a small extension that contributes them as defaults (configurationDefaults): the
# editor's lowest layer, so what the person sets in the editor, the project's devcontainer
# (Machine settings, editor-settings.ts) and the repository's .vscode/settings.json all
# override them. (Measured on the M1, 2026-11-18: this editor keeps its User settings in the
# browser, so a file on the server cannot be that layer; and Machine settings override what
# the person sets in the editor.) Run by the host after editor.sh, and again for every running
# workspace when the defaults change. An editor that is open takes them when it reloads.
#   editor-defaults.sh < settings.json
set -euo pipefail
SRV=/opt/desolate/editor/bin/codium-server
DATA="$HOME/.desolate-editor"
STATE=/run/desolate/devcontainer.json
[ -x "$SRV" ] || exit 0
umask 077
mkdir -p "$DATA/extensions"
SETTINGS=$(cat)
printf '%s' "$SETTINGS" | jq -e 'type == "object"' >/dev/null || { echo "editor-defaults: not a settings object" >&2; exit 2; }
WHERE=$(cat "$DATA/server.where" 2>/dev/null || echo vm)
# Installed already, the same, in the same place: nothing to do.
SUM="$(printf '%s %s' "$WHERE" "$SETTINGS" | sha256sum | cut -c1-16)"
if [ "$(cat "$DATA/defaults.sum" 2>/dev/null)" = "$SUM" ] && ls -d "$DATA/extensions"/desolate.defaults-* >/dev/null 2>&1; then
  exit 0
fi
python3 - "$DATA/defaults.vsix" "$SETTINGS" <<'PY'
import json, sys, zipfile
out, settings = sys.argv[1], json.loads(sys.argv[2])
package = {
    "name": "defaults", "displayName": "desolate: your default settings", "publisher": "desolate",
    "version": "1.0.0", "engines": {"vscode": "*"},
    "description": "The defaults you set with desolate editor defaults (or its page): every other setting overrides them.",
    "contributes": {"configurationDefaults": settings},
}
manifest = ('<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">'
            '<Metadata><Identity Language="en-US" Id="defaults" Version="1.0.0" Publisher="desolate"/><DisplayName>desolate: your default settings</DisplayName>'
            '<Description xml:space="preserve">defaults</Description></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>'
            '<Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>')
types = ('<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
         '<Default Extension=".json" ContentType="application/json"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>')
with zipfile.ZipFile(out, "w") as z:
    z.writestr("[Content_Types].xml", types)
    z.writestr("extension.vsixmanifest", manifest)
    z.writestr("extension/package.json", json.dumps(package))
PY
if [ "$WHERE" = vm ]; then
  "$SRV" --install-extension "$DATA/defaults.vsix" --force --extensions-dir "$DATA/extensions" --server-data-dir "$DATA" >/dev/null
else
  # The editor's directory is the container's /desolate/editor-data (editor.sh).
  docker exec -u "$(jq -r .remoteUser "$STATE")" "$WHERE" "$SRV" --install-extension /desolate/editor-data/defaults.vsix --force \
    --extensions-dir /desolate/editor-data/extensions --server-data-dir /desolate/editor-data >/dev/null
fi
printf '%s\n' "$SUM" >"$DATA/defaults.sum"
echo "editor defaults: $(printf '%s' "$SETTINGS" | jq -r 'keys | length') setting(s)"
