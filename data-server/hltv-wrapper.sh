#!/bin/bash
# HLTV launch wrapper — mirrors production's /home/hltvserver/hltv-wrapper.sh.
#
# Why this exists: HLTV must be started with a LIVE stdin. Launched bare (stdin
# at EOF, as supervisord does by default) the console's input path never pumps,
# and rcon commands are accepted and acknowledged but never dispatched — the
# server returns a well-formed 1400-byte response whose redirect buffer is
# entirely NUL. `status` looks broken while the proxy is otherwise healthy and
# broadcasting, which makes it a genuinely confusing failure to chase.
#
# Keeping a FIFO open on stdin (via `tail -f`, which never EOFs) is how
# production avoids it, and it doubles as a command channel:
#     echo "status" > /tmp/cmdpipes/hltv-27020.pipe
#
# Usage: hltv-wrapper.sh <instance-number> <port>
set -u

INSTANCE="$1"
PORT="$2"
PIPE_DIR="/tmp/cmdpipes"
PIPE="${PIPE_DIR}/hltv-${PORT}.pipe"
INSTANCE_DIR="/opt/hltv/instance-${INSTANCE}"

mkdir -p "$PIPE_DIR"
[ -p "$PIPE" ] || mkfifo "$PIPE"

cd "$INSTANCE_DIR" || exit 1

# `-game dod` matches production's invocation. The per-instance hltv.cfg is
# auto-exec'd from the working directory (start.sh stages it there), so unlike
# production there's no explicit +exec.
#
# The grep drops the RunFrame timer spam the container clock provokes — harmless
# but it buries real output. --line-buffered so log lines aren't held back.
# stdbuf -oL is load-bearing for measurement, not cosmetics. HLTV's stdout is a
# pipe, so libc block-buffers it and console lines surface in multi-second bursts.
# Anything that timestamps a log line then (a serve-clock sampler, a latency
# probe) correlates the wrong wall instant with the value and silently produces
# garbage — observed as a frozen World Time next to a Spectator Time jumping 20s
# in a 9s window. Line buffering makes the log a trustworthy time source.
# The tee'd copy is the one measurement tools should read. supervisord captures
# the child's stdout through its own event loop and flushes on its own schedule,
# so /var/log/supervisor/hltv-N.log is NOT a trustworthy time source — sampling
# it showed 9s wall gaps carrying anywhere from 1s to 17s of serve-clock motion.
# This copy is line-buffered end to end.
exec tail -f "$PIPE" \
    | stdbuf -oL ./hltv -game dod -port "$PORT" 2>&1 \
    | stdbuf -oL grep -v --line-buffered 'WARNING! System::RunFrame: system time difference' \
    | stdbuf -oL tee -a "/tmp/hltv-${PORT}.live.log"
