#!/usr/bin/env python3
"""Send a 96x96 RGB565 bitmap to the special RGB Ethernet layout."""

import argparse
import socket
import time

from PIL import Image


WIDTH = 96
HEIGHT = 96
PORT = 5001
MAGIC = b"RGBU"
CHUNK_SIZE = 1024
FRAME_BYTES = WIDTH * HEIGHT * 2
CHUNK_COUNT = (FRAME_BYTES + CHUNK_SIZE - 1) // CHUNK_SIZE


def rgb565_bytes(image):
    output = bytearray()
    for red, green, blue in image.getdata():
        value = ((red & 0xF8) << 8) | ((green & 0xFC) << 3) | (blue >> 3)
        output.extend((value >> 8, value & 0xFF))
    return bytes(output)


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
    parser.add_argument("image", help="PNG, JPEG, or another Pillow image")
    parser.add_argument("--host", required=True, help="Display IPv4 address")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--retries", type=int, default=2,
                        help="Complete-frame transmission attempts")
    parser.add_argument("--delay", type=float, default=0.01,
                        help="Seconds between UDP chunks")
    args = parser.parse_args()

    with Image.open(args.image) as source:
        image = source.convert("RGB").resize(
            (WIDTH, HEIGHT), Image.Resampling.LANCZOS
        )
    payload = rgb565_bytes(image)
    frame_id = int(time.monotonic() * 1000) & 0xFFFF
    expected_ack = MAGIC + bytes((frame_id >> 8, frame_id & 0xFF)) + b"OK"

    acknowledged = False
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.settimeout(1.0)
        for _ in range(max(1, args.retries)):
            for packet in frame_packets(payload, frame_id):
                udp.sendto(packet, (args.host, args.port))
                time.sleep(max(0, args.delay))
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
