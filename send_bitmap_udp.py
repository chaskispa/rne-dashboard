#!/usr/bin/env python3
"""Send an unchanged 96x96 big-endian RGB565 frame over UDP."""

import argparse
import os
import socket
import time


WIDTH = 96
HEIGHT = 96
PORT = 5001
MAGIC = b"RGBU"
CHUNK_SIZE = 1024
FRAME_BYTES = WIDTH * HEIGHT * 2
CHUNK_COUNT = (FRAME_BYTES + CHUNK_SIZE - 1) // CHUNK_SIZE


def environment_delay_ms():
    try:
        value = float(os.environ.get("RNE_BITMAP_CHUNK_DELAY_MS", "250"))
        return value if value >= 0 else 250.0
    except ValueError:
        return 250.0


DEFAULT_DELAY_MS = environment_delay_ms()


def frame_packets(payload, frame_id):
    if len(payload) != FRAME_BYTES:
        raise ValueError("Expected {} RGB565 bytes".format(FRAME_BYTES))
    for chunk_index in range(CHUNK_COUNT):
        offset = chunk_index * CHUNK_SIZE
        header = MAGIC + bytes((
            frame_id >> 8,
            frame_id & 0xFF,
            chunk_index,
            CHUNK_COUNT,
        ))
        yield header + payload[offset:offset + CHUNK_SIZE]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("bitmap", help="Raw 96x96 RGB565 big-endian file")
    parser.add_argument("--host", default="192.168.100.23",
                        help="Display IPv4 address")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--retries", type=int, default=2,
                        help="Complete-frame transmission attempts")
    parser.add_argument("--delay-ms", type=float, default=DEFAULT_DELAY_MS,
                        help="Milliseconds between UDP chunks")
    args = parser.parse_args()

    with open(args.bitmap, "rb") as bitmap_file:
        payload = bitmap_file.read()
    if len(payload) != FRAME_BYTES:
        raise ValueError("Expected {} RGB565 bytes, received {}".format(
            FRAME_BYTES, len(payload)
        ))
    frame_id = int(time.monotonic() * 1000) & 0xFFFF
    expected_ack = MAGIC + bytes((frame_id >> 8, frame_id & 0xFF)) + b"OK"

    acknowledged = False
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.settimeout(1.0)
        for _ in range(max(1, args.retries)):
            for chunk_index, packet in enumerate(frame_packets(payload, frame_id)):
                udp.sendto(packet, (args.host, args.port))
                if chunk_index < CHUNK_COUNT - 1:
                    time.sleep(max(0, args.delay_ms) / 1000.0)
            try:
                response, _ = udp.recvfrom(32)
                if response == expected_ack:
                    acknowledged = True
                    break
            except socket.timeout:
                pass

    if not acknowledged:
        raise RuntimeError("Display did not acknowledge the complete bitmap")
    print("Sent 96x96 RGB565 frame {} ({} bytes in {} chunks)".format(
        frame_id, len(payload), CHUNK_COUNT
    ))


if __name__ == "__main__":
    main()
