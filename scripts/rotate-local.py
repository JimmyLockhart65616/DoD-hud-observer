#!/usr/bin/env python3
"""Rapid map-rotation driver for local game-1 DODX degradation repro.
Loops through the mapcycle via rcon, waits ~20s per map.
Prints rotation count + timestamp so log correlation is easy."""
import socket, sys, time

HOST, PORT, PW = '127.0.0.1', 27016, 'changeme'
MAPS = [
    'dod_anzio', 'dod_flash', 'dod_avalanche', 'dod_caen', 'dod_charlie',
    'dod_chemille', 'dod_donner', 'dod_escape', 'dod_flugplatz', 'dod_forest',
    'dod_glider', 'dod_jagd', 'dod_kalt', 'dod_kraftstoff', 'dod_merderet',
    'dod_switch', 'dod_vicenza', 'dod_zalec',
]
DELAY = 20  # seconds between changelevels

def rcon(cmd: str) -> bytes:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(3)
    s.sendto(b'\xff\xff\xff\xffchallenge rcon\n', (HOST, PORT))
    data, _ = s.recvfrom(4096)
    token = data[len(b'\xff\xff\xff\xffchallenge rcon '):].rstrip(b'\n\x00 ')
    payload = b'\xff\xff\xff\xffrcon ' + token + b' ' + PW.encode() + b' ' + cmd.encode() + b'\n'
    s.sendto(payload, (HOST, PORT))
    try:
        buf = b''
        while True:
            d, _ = s.recvfrom(8192)
            buf += d
    except socket.timeout:
        return buf

i = 0
while True:
    target = MAPS[i % len(MAPS)]
    ts = time.strftime('%H:%M:%S')
    print(f'[{ts}] #{i+1} -> changelevel {target}', flush=True)
    try:
        rcon(f'changelevel {target}')
    except Exception as e:
        print(f'[{ts}] rcon error: {e}', flush=True)
    i += 1
    time.sleep(DELAY)
