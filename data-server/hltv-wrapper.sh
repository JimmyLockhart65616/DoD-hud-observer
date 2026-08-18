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
# hltv must be the pipeline HEAD, not a middle stage. The obvious spelling —
#     tail -f "$PIPE" | ./hltv ... | grep | tee
# also keeps stdin live, but when hltv dies grep and tee exit while `tail -f`
# never does, so this script never exits either. supervisord only restarts a
# program when it EXITS, so a crashed proxy stays dead silently and forever.
# Holding the FIFO open read+write on fd 3 gives the same never-EOF stdin
# without the extra stage: reads block instead of seeing EOF, the command
# channel still works, and hltv's death now tears the pipeline down and exits.
#
#     echo "status" > /tmp/cmdpipes/hltv-27020.pipe
#
# The grep drops the RunFrame timer spam the container clock provokes — harmless
# but it buries real output. --line-buffered so log lines aren't held back, and
# stdbuf -oL on grep/tee for the same reason.
#
# NOTE: hltv's OWN stdout cannot be line-buffered this way. `stdbuf` works by
# LD_PRELOADing libstdbuf.so, and this image's coreutils is 64-bit while hltv is
# a 32-bit binary — the preload is rejected outright ("wrong ELF class") and
# stdbuf silently degrades to a no-op while spamming the error into the log. So
# hltv's console output reaches us in libc-sized blocks, and this file is NOT a
# trustworthy sub-second time source: sampling it showed 9s wall gaps carrying
# anywhere from 1s to 17s of serve-clock motion. Take measurement anchors from
# rcon instead (e2e/repro/local-e2e-align.cjs), which timestamps its own request.
exec 3<>"$PIPE"

./hltv -game dod -port "$PORT" <&3 2>&1 \
    | stdbuf -oL grep -v --line-buffered 'WARNING! System::RunFrame: system time difference' \
    | stdbuf -oL tee -a "/tmp/hltv-${PORT}.live.log"
