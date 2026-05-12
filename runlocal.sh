#!/bin/bash

prettier --write "**/*.js"
prettier --write "**/*.html"

# Note: use `eval "$(...)"` instead of `source <(...)` — the latter does not
# reliably propagate multi-line variables in bash 3.2 (the macOS default).
eval "$(
  yq eval '
    to_entries
    | .[]
    | "export \(.key)=\(.value | @sh)"
  ' env.yaml
)"

node -p 'process.env.TG_INFO_JSON'
node -p 'process.env.CALLSIGN_INFO_JSON'

npm start
