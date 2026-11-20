#!/usr/bin/env bash
# Score an OCR model running on a RENTED GPU against the conversion fixtures.
#
# ── On the pod (RunPod / Vast / Lambda; one 24GB card: RTX 4090, L4, A10) ──
#   Expose HTTP port 8000. Use the vllm/vllm-openai image (>= v0.11.0, where
#   dots.ocr is built into vLLM) or `pip install -U vllm`, then:
#
#     vllm serve rednote-hilab/dots.mocr --trust-remote-code \
#       --served-model-name model --chat-template-content-format string \
#       --gpu-memory-utilization 0.9 --port 8000 --api-key <your-secret>
#
#   (dots.mocr = dots.ocr 1.5. For the original: rednote-hilab/dots.ocr.)
#   Ready when the log says it is serving on port 8000. ALWAYS pass --api-key:
#   the pod's proxy URL is public.
#
# ── On your Mac ──
#   export OCR_POD_KEY=<your-secret>
#   tests/conversion/pod_ocr_eval.sh https://<pod-id>-8000.proxy.runpod.net [fixtures] [engine-name]
#
#   fixtures     comma-separated fixture-path substrings (default: a 4-fixture
#                smoke set); "all" = the whole PDF corpus
#   engine-name  cache/report label (default pod-dots). Use a new one per model,
#                e.g. pod-dots-ocr1 vs pod-dots-mocr, or their caches mix.
#
# Pages are cached under engine-cache/<fixture>/<engine-name>/pages (RAW model
# answers — re-parsing never needs the GPU again), so a dead pod just means
# re-run. Results: engine-cache/ENGINES_REPORT.md (sec/page is the number that
# sizes hardware). TERMINATE THE POD WHEN DONE — it bills by the second.
set -euo pipefail

URL="${1:-}"
FIXTURES="${2:-85542c5e,0fb751c1,21696c70,tiny-print-note-block-deloitte}"
ENGINE_NAME="${3:-pod-dots}"

if [[ -z "$URL" ]]; then
  sed -n '2,30p' "$0"; exit 1
fi
if [[ -z "${OCR_POD_KEY:-}" ]]; then
  echo "Set OCR_POD_KEY to the --api-key you gave vllm serve." >&2; exit 1
fi

BASE="${URL%/}"; BASE="${BASE%/v1}/v1"
cd "$(dirname "$0")"

echo "Checking $BASE/models ..."
code=$(curl -s -o /tmp/pod_models.$$ -w '%{http_code}' -H "Authorization: Bearer $OCR_POD_KEY" "$BASE/models" || true)
if [[ "$code" != "200" ]]; then
  echo "Pod not answering (HTTP $code). Still loading the model? Wrong URL/port? Key mismatch (401)?" >&2
  cat /tmp/pod_models.$$ 2>/dev/null | head -c 300 >&2; rm -f /tmp/pod_models.$$; exit 1
fi
echo "Serving: $(python3 -c 'import json,sys;print(", ".join(m["id"] for m in json.load(open(sys.argv[1]))["data"]))' /tmp/pod_models.$$)"
rm -f /tmp/pod_models.$$

ARGS=(--full --regression --yes --engines pod-dots --engine-name "$ENGINE_NAME" --base-url "$BASE")
if [[ "$FIXTURES" != "all" ]]; then ARGS+=(--fixtures "$FIXTURES"); fi

# Every compare run OVERWRITES the report with only the engines it ran — keep
# the previous one (the DeepInfra baseline) beside it.
for f in ENGINES_REPORT.md report.json; do
  if [[ -f "engine-cache/$f" ]]; then cp "engine-cache/$f" "engine-cache/${f%.*}.prev.${f##*.}"; fi
done

python3 ocr_engine_compare.py "${ARGS[@]}"
echo
echo "Report: $(pwd)/engine-cache/ENGINES_REPORT.md  — now TERMINATE the pod."
