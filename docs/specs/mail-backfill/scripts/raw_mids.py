"""Extract Message-ID from raw bytes without a structured parser.

email.policy.default parses Message-ID as an addr-spec and truncates malformed
values that contain two '@' signs, which disagrees with what Stalwart stores.
This takes the literal text between the first '<' and the matching '>' on the
unfolded Message-ID header instead.
"""

import re
import sqlite3

DB = "/Users/scott/mail-backfill/google.sqlite"
OUT = "/tmp/arch-mids-raw.txt"

# Header block only; unfold continuation lines before matching.
hdr_re = re.compile(rb"^message-id\s*:(.*?)(?=\r?\n[^ \t]|\Z)", re.I | re.M | re.S)
angle_re = re.compile(rb"<([^>]*)>", re.S)

con = sqlite3.connect(DB)
with open(OUT, "w") as out:
    for (data,) in con.execute(
        "select b.data from emails e join blobs b on b.id = e.blob_id"
    ):
        head = data.split(b"\r\n\r\n", 1)[0].split(b"\n\n", 1)[0]
        m = hdr_re.search(head)
        if not m:
            out.write("NONE\n")
            continue
        value = re.sub(rb"\r?\n[ \t]+", b" ", m.group(1)).strip()
        a = angle_re.search(value)
        raw = a.group(1) if a else value
        out.write(raw.decode("utf-8", "replace").strip().replace(" ", "") + "\n")
