#!/usr/bin/env bash
# Runs one config: $1=model $2=effort $3=tier $4=repeats. Sequential per config.
set -u
cd "$(dirname "$0")"
model="$1"; effort="$2"; tier="$3"; repeats="${4:-2}"
tag="${model#gpt-5.6-}-${effort}-${tier}"
work="$(mktemp -d)"
for doc in short long; do
  for i in $(seq 1 "$repeats"); do
    out="${OUT:-out}/${tag}-${doc}-${i}"
    { cat prompt.txt; echo; cat "reply-${doc}.md"; } > "$work/prompt.txt"
    start=$(date +%s%N)
    codex exec --ephemeral --skip-git-repo-check -s read-only \
      --model "$model" --config "model_reasoning_effort=\"$effort\"" --config "service_tier=\"$tier\"" \
      --output-schema schema.json --output-last-message "$out.json" - \
      < "$work/prompt.txt" > "$out.stdout" 2> "$out.stderr"
    code=$?
    end=$(date +%s%N)
    ms=$(( (end - start) / 1000000 ))
    echo "{\"tag\":\"$tag\",\"doc\":\"$doc\",\"run\":$i,\"ms\":$ms,\"exit\":$code}" >> ${OUT:-out}/timings.jsonl
    echo "$tag $doc run$i ${ms}ms exit=$code"
  done
done
rm -rf "$work"
