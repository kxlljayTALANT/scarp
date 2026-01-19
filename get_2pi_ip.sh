#!/usr/bin/env bash
set -euo pipefail

output_file="${1:-2pi_response.txt}"

curl -sS "https://2pi.com/" -o "$output_file"
echo "Saved response to ${output_file}"
