#!/usr/bin/env python3
"""Send PokerSt8ts round records to the AS400 datastream endpoint.

The browser can fire these itself, but it cannot read a cross-origin response,
so it can never confirm delivery. Run server-side there is no CORS and the HTTP
status is visible, which makes this the reliable path.

The endpoint is used exactly as supplied and is never rewritten:

    https://www.centriko.com/charity/datastream?<RECORD>

Usage
-----
    # one record on the command line
    ./as400_report.py TOURC33267CHARITYTEST1111111111...

    # a file of records, one per line
    ./as400_report.py --file records.txt

    # records piped in
    cat records.txt | ./as400_report.py

    # show what would be sent, send nothing
    ./as400_report.py --file records.txt --dry-run

Exit status is 0 only when every record was accepted, so it can be used in a
scheduled job without hiding failures.
"""

from __future__ import annotations

import argparse
import sys
import time
import urllib.error
import urllib.request

ENDPOINT = "https://www.centriko.com/charity/datastream"
RECORD_LENGTH = 192
RETRIES = 3
BACKOFF_SECONDS = 2
TIMEOUT_SECONDS = 30


def record_url(record: str) -> str:
    """The exact URL a record is sent to. The record is the query string."""
    return f"{ENDPOINT}?{record.strip()}"


def send(record: str, *, dry_run: bool = False) -> bool:
    """Send one record. Retries transient failures; returns True on success."""
    url = record_url(record)
    if dry_run:
        print(f"[dry-run] {url}")
        return True

    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
                if 200 <= resp.status < 300:
                    print(f"[ok {resp.status}] {record.strip()[:60]}...")
                    return True
                print(f"[http {resp.status}] attempt {attempt}/{RETRIES}", file=sys.stderr)
        except urllib.error.HTTPError as e:
            # 4xx means the record itself is wrong; retrying will not fix it.
            if 400 <= e.code < 500:
                print(f"[rejected {e.code}] {record.strip()[:60]}...", file=sys.stderr)
                return False
            print(f"[http {e.code}] attempt {attempt}/{RETRIES}", file=sys.stderr)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            print(f"[network] {e} attempt {attempt}/{RETRIES}", file=sys.stderr)

        if attempt < RETRIES:
            time.sleep(BACKOFF_SECONDS * attempt)

    print(f"[failed] {record.strip()[:60]}...", file=sys.stderr)
    return False


def read_records(args: argparse.Namespace) -> list[str]:
    if args.records:
        return list(args.records)
    stream = open(args.file, encoding="utf-8") if args.file else sys.stdin
    with stream as fh:
        # Strip the line ending only. Trailing spaces are significant: they are
        # the fixed-width padding, and stripping them corrupts the record.
        return [line for line in (raw.rstrip("\r\n") for raw in fh) if line.strip()]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("records", nargs="*", help="record(s) to send")
    p.add_argument("--file", help="file of records, one per line")
    p.add_argument("--dry-run", action="store_true", help="print URLs without sending")
    p.add_argument("--strict", action="store_true", help=f"refuse records that are not {RECORD_LENGTH} chars")
    args = p.parse_args()

    records = read_records(args)
    if not records:
        print("no records to send", file=sys.stderr)
        return 1

    failed = 0
    for record in records:
        if args.strict and len(record) != RECORD_LENGTH:
            print(f"[bad length {len(record)}, want {RECORD_LENGTH}] {record[:40]}...", file=sys.stderr)
            failed += 1
            continue
        if not send(record, dry_run=args.dry_run):
            failed += 1

    total = len(records)
    print(f"{total - failed}/{total} delivered", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
