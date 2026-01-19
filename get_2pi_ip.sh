#!/usr/bin/env bash
set -euo pipefail

output_file="${1:-2ip_response.txt}"
primary_url="https://2ip.io/"
fallback_url="http://2ip.io/"

if curl -sS "$primary_url" -o "$output_file"; then
  :
else
  curl -sS "$fallback_url" -o "$output_file"
fi
echo "Saved response from 2ip.io to ${output_file}"
