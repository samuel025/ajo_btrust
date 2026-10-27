#!/usr/bin/env bash
# Opens a channel from a local Alby Hub to a peer, bypassing the UI's node lookup (which
# fails for unannounced signet nodes). Prompts for the hub password; nothing is stored.
# usage: scripts/open-channel.sh <pubkey>@<host>:<port> <amount-sats> [hub-url]
set -euo pipefail
peer="${1:?peer as pubkey@host:port}"
amount="${2:?amount in sats}"
hub="${3:-http://localhost:8080}"
pubkey="${peer%@*}"; hostport="${peer#*@}"; host="${hostport%:*}"; port="${hostport#*:}"

read -rsp "Hub password: " password; echo
token=$(curl -sf "$hub/api/unlock" -H 'Content-Type: application/json' \
  -d "$(printf '{"unlockPassword":"%s","permission":"full"}' "$password")" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
auth=(-H "Authorization: Bearer $token" -H 'Content-Type: application/json')

echo "Connecting to peer..."
curl -sf "${auth[@]}" "$hub/api/peers" -d "{\"pubkey\":\"$pubkey\",\"address\":\"$host\",\"port\":$port}" && echo " connected"
echo "Opening channel..."
curl -sf "${auth[@]}" "$hub/api/channels" -d "{\"pubkey\":\"$pubkey\",\"amountSats\":$amount,\"public\":false}"
echo
