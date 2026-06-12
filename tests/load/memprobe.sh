#!/bin/bash
# memprobe.sh — sample the RSS of one or more process TREES (root + all
# descendants, catching python/pandoc children of PHP workers) once per second
# until every root exits; report per-tree and combined peaks.
#
# The RAM companion to loadprobe.php (HTTP) and `php artisan queue:probe`
# (topology): those tell you WHO runs in parallel; this tells you whether the
# box can AFFORD it. Built to answer "does max usage fit in the droplet's 2GB?"
# — run the heaviest real jobs concurrently and watch their peaks.
#
# Usage:
#   tests/load/memprobe.sh import:12345 citation:12346
#   (label:pid pairs; sampling stops when all PIDs are gone)
#
# Output: live samples to stderr, final report + peaks to stdout.

set -u

if [ $# -eq 0 ]; then
  echo "usage: $0 label:pid [label:pid ...]" >&2
  exit 1
fi

LABELS=()
ROOTS=()
PEAKS=()
for arg in "$@"; do
  LABELS+=("${arg%%:*}")
  ROOTS+=("${arg##*:}")
  PEAKS+=(0)
done
COMBINED_PEAK=0

tree_rss_kb() { # $1 = root pid → echoes summed RSS (KB) of pid + descendants
  ps -axo pid=,ppid=,rss= | awk -v root="$1" '
    { pid[NR]=$1; ppid[NR]=$2; rss[NR]=$3 }
    END {
      want[root]=1
      changed=1
      while (changed) {            # transitive closure over the child map
        changed=0
        for (i=1;i<=NR;i++) if (want[ppid[i]] && !want[pid[i]]) { want[pid[i]]=1; changed=1 }
      }
      total=0
      for (i=1;i<=NR;i++) if (want[pid[i]]) total+=rss[i]
      print total
    }'
}

START=$(date +%s)
while :; do
  alive=0
  combined=0
  line="t=$(( $(date +%s) - START ))s"
  for i in "${!ROOTS[@]}"; do
    if kill -0 "${ROOTS[$i]}" 2>/dev/null; then
      alive=1
      kb=$(tree_rss_kb "${ROOTS[$i]}")
    else
      kb=0
    fi
    mb=$(( kb / 1024 ))
    combined=$(( combined + mb ))
    [ "$mb" -gt "${PEAKS[$i]}" ] && PEAKS[$i]=$mb
    line="$line  ${LABELS[$i]}=${mb}MB"
  done
  [ "$combined" -gt "$COMBINED_PEAK" ] && COMBINED_PEAK=$combined
  echo "$line  combined=${combined}MB" >&2
  [ "$alive" -eq 0 ] && break
  sleep 1
done

echo "── memprobe peaks ──"
for i in "${!LABELS[@]}"; do
  echo "${LABELS[$i]}: ${PEAKS[$i]} MB peak"
done
echo "combined (simultaneous): ${COMBINED_PEAK} MB peak"
