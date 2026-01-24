#!/bin/bash

prettier --write "**/*.js"
prettier --write "**/*.html"

source <(
  yq eval '
    to_entries
    | .[]
    | "export \(.key)=\(.value | @sh)"
  ' env.yaml
)

node -p 'process.env.TG_INFO_JSON'
node -p 'process.env.CALLSIGN_INFO_JSON'

npm start
