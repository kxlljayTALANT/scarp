#!/usr/bin/env bash
set -euo pipefail

output_file="${1:-2pi_response.txt}"

if curl -sS "https://2pi.com/" -o "$output_file"; then
  :
else
  curl -sS "http://2pi.com/" -o "$output_file"
fi
echo "Saved response to ${output_file}"
