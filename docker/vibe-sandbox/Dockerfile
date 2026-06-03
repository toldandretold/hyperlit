# Sandbox image for running LLM-generated conversion code during a "vibe conversion".
#
# The vibe-conversion loop (app/Python/vibe_convert.py) proposes a patch to a conversion module,
# applies it in a throwaway copy, and RE-CONVERTS the document to check it. That re-conversion
# executes model-written Python — so on prod it must run with NO network, NO secrets, and NO
# access to the host filesystem beyond the few dirs we bind-mount.
#
# This image carries only the Python conversion deps (NOT pandoc — the re-conversion starts from
# the already-pandoc'd intermediate.html / cached OCR, so pandoc is never re-run; and NOT the
# LLM/network libs — the model call happens on the HOST, never inside this container).
#
# Build (on the droplet):   docker build -t hyperlit-vibe-sandbox docker/vibe-sandbox
# It is invoked by vibe_convert.py --docker hyperlit-vibe-sandbox with:
#   --network none --read-only --tmpfs /tmp --memory 1g --cpus 1 --pids-limit 256
#   --user <worker-uid> -v <sandbox>:<sandbox>:ro -v <book>:<book>:ro -v <out>:<out>
FROM python:3.12-slim

# Conversion runtime deps only. lxml needs libxml2/libxslt; Pillow needs zlib/jpeg.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libxml2 libxslt1.1 libjpeg62-turbo zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir \
        beautifulsoup4 lxml bleach python-docx "Pillow>=10.0" pypdf mistralai

# Run unprivileged by default; the caller also passes --user <host-uid> so writes to the bind-
# mounted output dir keep the worker's ownership.
USER nobody

# No ENTRYPOINT/CMD: vibe_convert.py supplies the exact `python <script> <args>` to run.
