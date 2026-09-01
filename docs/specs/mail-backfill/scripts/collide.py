"""Determine why 306 VEVENT UIDs from the Takeout .ics are absent from the archive.

Hypothesis under test: vandelay upserts calendar events on a content-derived key
rather than on UID, so a "missing" UID is a duplicate of one that landed rather
than a dropped event.

Reads the unfolded .ics and the archive; prints tallies only, never event content.
"""

import json
import sqlite3
import sys
from collections import defaultdict

ICS = "/tmp/unfolded.ics"
DB = "/Users/scott/mail-backfill/google.sqlite"


def parse_vevents(path):
    """Yield one dict of properties per VEVENT block."""
    events = []
    cur = None
    depth_alarm = False
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            line = raw.rstrip("\r\n")
            if line.startswith("BEGIN:VEVENT"):
                cur = defaultdict(list)
                continue
            if line.startswith("END:VEVENT"):
                if cur is not None:
                    events.append(cur)
                cur = None
                continue
            if cur is None:
                continue
            if line.startswith("BEGIN:VALARM"):
                depth_alarm = True
                continue
            if line.startswith("END:VALARM"):
                depth_alarm = False
                continue
            if depth_alarm:
                continue
            if ":" not in line:
                continue
            name = line.split(":", 1)[0].split(";", 1)[0].upper()
            cur[name].append(line)
    return events


def one(ev, key):
    vals = ev.get(key) or []
    if not vals:
        return ""
    return vals[0].split(":", 1)[1] if ":" in vals[0] else ""


def main():
    events = parse_vevents(ICS)
    print(f"VEVENT blocks parsed: {len(events)}")

    by_uid = defaultdict(list)
    for ev in events:
        by_uid[one(ev, "UID")].append(ev)
    print(f"distinct UIDs: {len(by_uid)}")

    con = sqlite3.connect(DB)
    db_uids = {r[0] for r in con.execute(
        "select json_extract(data,'$.uid') from calendar_events")}
    print(f"archive rows: {len(db_uids)}")

    missing = sorted(u for u in by_uid if u not in db_uids)
    present = sorted(u for u in by_uid if u in db_uids)
    print(f"missing UIDs: {len(missing)}")
    print("---")

    # Does every block for a missing UID carry RECURRENCE-ID (i.e. it is an
    # override, folded into some master rather than stored on its own)?
    all_override = sum(
        1 for u in missing if all(ev.get("RECURRENCE-ID") for ev in by_uid[u]))
    print(f"missing UIDs whose every block has RECURRENCE-ID: {all_override}")

    # Content-key collision test: (DTSTART, SUMMARY) of a missing UID matching
    # the same pair on a UID that did land.
    def ckey(ev):
        return (one(ev, "DTSTART"), one(ev, "SUMMARY"))

    present_keys = defaultdict(set)
    for u in present:
        for ev in by_uid[u]:
            present_keys[ckey(ev)].add(u)

    collide = 0
    for u in missing:
        if any(ckey(ev) in present_keys for ev in by_uid[u]):
            collide += 1
    print(f"missing UIDs colliding with a present UID on (DTSTART, SUMMARY): {collide}")

    unexplained = [
        u for u in missing
        if not all(ev.get("RECURRENCE-ID") for ev in by_uid[u])
        and not any(ckey(ev) in present_keys for ev in by_uid[u])
    ]
    print(f"missing UIDs explained by neither: {len(unexplained)}")

    if unexplained:
        print("--- shape of the unexplained ones (property names only) ---")
        shapes = defaultdict(int)
        for u in unexplained[:400]:
            for ev in by_uid[u]:
                shapes[tuple(sorted(ev.keys()))] += 1
        for shape, n in sorted(shapes.items(), key=lambda kv: -kv[1])[:6]:
            print(f"{n}\t{', '.join(shape)}")


if __name__ == "__main__":
    sys.exit(main())
