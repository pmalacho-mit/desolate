# Tab completion for `desolate`, for zsh and bash. To have it in every new terminal:
#   echo 'source <(desolate completion)' >> ~/.zshrc     (bash: ~/.bashrc)
# In zsh it runs through bashcompinit, which it loads itself (and compinit first, when the
# shell has not), so that one line is all ~/.zshrc needs.
#
# Nothing here starts node or asks a VM: a TAB must answer at once. Domain and workspace
# names are read from the host's own files, which only the root VM writes
# (~/.desolate/domains/<domain>/inbox/workspaces/<workspace>.json).
#
# Hardening kept from v2's completion: a name is offered only if it is a slug. A file name
# is something a program can choose, and a completion that offers `$(...)`, an option-like
# word or a control sequence would put it on the person's command line.
# The rule is shared/names.ts's isSlug, clause for clause. Shell cannot import it, so T1
# (tests/v3/t1/scripts.test.ts) reads this line and compares the two, name by name. The
# letters are spelled out: in a UTF-8 locale, [a-z] matches é too (macOS's bash, measured).
_desolate_home="${DESOLATE_HOME:-$HOME/.desolate}"
_desolate_slug() { [[ $1 =~ ^[0123456789abcdefghijklmnopqrstuvwxyz][-0123456789abcdefghijklmnopqrstuvwxyz]{0,39}$ && $1 != *- && $1 != *--*--* && $1 != xn--* && $1 != *---* ]]; }
_desolate_domains() {
    local dir name
    for dir in "$_desolate_home"/domains/*/; do
        name=${dir%/}; name=${name##*/}
        if _desolate_slug "$name" && [ -d "$dir/inbox" ]; then printf '%s\n' "$name"; fi
    done
    return 0
}
_desolate_workspaces() {
    local file domain name
    for file in "$_desolate_home"/domains/*/inbox/workspaces/*.json; do
        [ -f "$file" ] || continue
        name=${file##*/}; name=${name%.json}
        domain=${file%/inbox/workspaces/*}; domain=${domain##*/}
        if _desolate_slug "$domain" && _desolate_slug "$name"; then printf '%s/%s\n' "$domain" "$name"; fi
    done
    return 0
}
_desolate_repos() {
    local dir owner name
    for dir in "$_desolate_home"/mirrors/*/*.git/; do
        [ -d "$dir" ] || continue
        name=${dir%.git/}; owner=${name%/*}; owner=${owner##*/}; name=${name##*/}
        if [[ "$owner/$name" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*/[A-Za-z0-9_][A-Za-z0-9._-]*$ ]]; then printf '%s/%s\n' "$owner" "$name"; fi
    done
    return 0
}
_desolate() {
    local cur=${COMP_WORDS[COMP_CWORD]} verb=${COMP_WORDS[1]:-} words=""
    COMPREPLY=()
    # After `--` everything is the command to run inside: not ours to complete.
    local i
    for ((i = 1; i < COMP_CWORD; i++)); do [ "${COMP_WORDS[i]}" = "--" ] && return 0; done
    if [ "$COMP_CWORD" -eq 1 ]; then
        words="bootstrap doctor destroy down clone fetch repos keys domain up list status board start stop resize rm exec editor ui ports offers branches review push approve root net git events notify agent suede upstream settings completion help"
    else
        case "$verb" in
            domain)
                if [ "$COMP_CWORD" -eq 2 ]; then words="create $(_desolate_domains)"
                elif [ "$COMP_CWORD" -eq 3 ] && [ "${COMP_WORDS[2]}" != create ]; then words="add show net secret"
                elif [ "${COMP_WORDS[3]:-}" = net ] && [ "$COMP_CWORD" -eq 4 ]; then words="show open enforce allow deny allow-internal recommend hold"
                elif [ "${COMP_WORDS[3]:-}" = net ] && [ "${COMP_WORDS[4]:-}" = recommend ]; then words="--all"
                elif [ "${COMP_WORDS[3]:-}" = secret ] && [ "$COMP_CWORD" -eq 4 ]; then words="list set copy on off rm"
                elif [ "${COMP_WORDS[3]:-}" = add ]; then words="--repo $(_desolate_repos)"
                fi ;;
            up) if [ "$COMP_CWORD" -eq 2 ]; then words="$(_desolate_domains)"; else words="--name --checkout --base --fetch"; fi ;;
            start|stop|resize|editor|ports) if [ "$COMP_CWORD" -eq 2 ]; then words="$(_desolate_workspaces)"; fi ;;
            status|board|list|offers|branches) if [ "$COMP_CWORD" -eq 2 ]; then words="$(_desolate_workspaces) $(_desolate_domains) --json"; fi ;;
            rm) if [ "$COMP_CWORD" -eq 2 ]; then words="$(_desolate_workspaces) $(_desolate_domains)"; fi ;;
            exec) if [ "$COMP_CWORD" -eq 2 ]; then words="$(_desolate_workspaces)"; else words="--checkout --vm --"; fi ;;
            clone) if [ "$COMP_CWORD" -gt 2 ]; then words="--no-push --anonymous --domain --no-domain --keys-by-hand"; fi ;;
            fetch) words="$(_desolate_repos)" ;;
            upstream) if [ "$COMP_CWORD" -eq 2 ] || [ "$COMP_CWORD" -eq 4 ]; then words="$(_desolate_repos)"; else words="--from --no-wait --remote"; fi ;;
            review|push)
                if [ "$COMP_CWORD" -eq 2 ]; then words="$(_desolate_domains)"
                elif [ "$COMP_CWORD" -eq 3 ]; then words="$(_desolate_repos)"
                elif [ "$verb" = push ]; then words="--expect --allow-default"
                fi ;;
            approve) words="--selftest" ;;
            root) if [ "$COMP_CWORD" -eq 2 ]; then words="shell"; fi ;;
            net) if [ "$COMP_CWORD" -eq 2 ]; then words="log"; else words="$(_desolate_domains) --last --json"; fi ;;
            agent)
                if [ "$COMP_CWORD" -eq 2 ]; then words="start attach list log stop"
                elif [ "$COMP_CWORD" -eq 3 ]; then words="$(_desolate_workspaces)"
                else case "${COMP_WORDS[2]}" in
                    start) words="--name --checkout --" ;;
                    attach) words="--name" ;;
                    list) words="--json" ;;
                    log) words="--name --all --lines --since --raw" ;;
                    stop) words="--name --kill" ;;
                esac; fi ;;
            # (A setting's name is not offered: the settings are known by loading desolate's
            # code, which a completion must not do on every key press. `desolate settings` lists them.)
            settings) if [ "$COMP_CWORD" -eq 2 ]; then words="set unset --json"; fi ;;
            destroy) words="--all" ;;
            doctor|repos|keys) words="--json" ;;
        esac
    fi
    # shellcheck disable=SC2207
    COMPREPLY=($(compgen -W "$words" -- "$cur"))
}
if [ -n "${ZSH_VERSION-}" ]; then
    # zsh's `complete` is bashcompinit's, which needs compinit's compdef. (zsh only: plain
    # zsh syntax would not parse in bash.)
    autoload -U +X compinit bashcompinit
    if ! type compdef >/dev/null 2>&1; then compinit -i; fi
    bashcompinit
fi
complete -F _desolate desolate
complete -F _desolate cli.sh
