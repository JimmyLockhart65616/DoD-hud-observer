#!/usr/bin/env python3
"""Minimal HLDS rcon client for diagnostics. Usage: rcon.py HOST PORT PASS CMD..."""
import socket, sys

host, port, password = sys.argv[1], int(sys.argv[2]), sys.argv[3]
cmd = " ".join(sys.argv[4:])

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(3)

# Step 1: challenge
s.sendto(b"\xff\xff\xff\xffchallenge rcon\n", (host, port))
data, _ = s.recvfrom(4096)
# "\xff\xff\xff\xffchallenge rcon <TOKEN>\n\x00"
token = data.decode(errors="replace").split("challenge rcon")[1].strip().strip("\x00")

# Step 2: command (no trailing null, no quotes around password in our variant)
payload = f'\xff\xff\xff\xffrcon {token} {password} {cmd}\n'.encode()
s.sendto(payload, (host, port))

# Step 3: drain response — GoldSrc prefixes each packet with \xff\xff\xff\xffl
try:
    while True:
        data, _ = s.recvfrom(8192)
        # strip 4-byte OOB header; first byte of payload is 'l' for log/reply
        body = data[4:]
        if body.startswith(b"l"):
            body = body[1:]
        sys.stdout.write(body.decode(errors="replace"))
        sys.stdout.flush()
except socket.timeout:
    pass
