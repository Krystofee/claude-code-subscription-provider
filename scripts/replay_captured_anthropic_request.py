#!/usr/bin/env python3

import argparse
import json
import sys
from pathlib import Path
from urllib import request as urllib_request

DROP_HEADERS = {
    'host',
    'content-length',
    'accept-encoding',
    'connection',
}


def load_transaction(transactions_path: Path, request_id: str | None, match_path: str | None):
    for line in transactions_path.read_text().splitlines():
        obj = json.loads(line)
        if obj['request']['host'] != 'api.anthropic.com':
            continue
        if request_id and obj['id'] != request_id:
            continue
        if match_path and not obj['request']['path'].startswith(match_path):
            continue
        return obj
    raise SystemExit('No matching transaction found')


def make_headers(raw_headers: dict) -> dict:
    headers = {}
    for key, value in raw_headers.items():
        if key.lower() in DROP_HEADERS:
            continue
        headers[key] = value
    return headers


def print_headers(title: str, headers) -> None:
    print(title)
    items = headers.items() if hasattr(headers, 'items') else headers
    for key, value in items:
        print(f'{key}: {value}')
    print()


def main() -> int:
    parser = argparse.ArgumentParser(description='Replay captured Claude Code request to api.anthropic.com')
    parser.add_argument('--transactions', default='unredacted-logs/transactions.ndjson')
    parser.add_argument('--id', help='Exact captured transaction id')
    parser.add_argument('--match-path', default='/v1/messages', help='First api.anthropic.com path prefix to replay')
    parser.add_argument('--body-lines', type=int, default=40, help='How many response lines to print (0 = all)')
    parser.add_argument('--show-request', action='store_true', help='Print request headers and body before replay')
    args = parser.parse_args()

    tx = load_transaction(Path(args.transactions), args.id, args.match_path)
    url = f"https://api.anthropic.com{tx['request']['path']}"
    headers = make_headers(tx['request']['headers'])
    body_path = Path(tx['request']['body']['file'])
    body = body_path.read_bytes()

    if args.show_request:
        print_headers('=== REQUEST HEADERS ===', headers)
        print('=== REQUEST BODY ===')
        print(body.decode('utf-8'))
        print()

    req = urllib_request.Request(url, data=body, headers=headers, method=tx['request']['method'])

    with urllib_request.urlopen(req, timeout=120) as resp:
        print(f'STATUS: {resp.status}')
        print_headers('=== RESPONSE HEADERS ===', resp.headers.items())
        print('=== RESPONSE BODY ===')
        lines_printed = 0
        for raw_line in resp:
            line = raw_line.decode('utf-8', errors='replace').rstrip('\n')
            print(line)
            lines_printed += 1
            if args.body_lines and lines_printed >= args.body_lines:
                break

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
