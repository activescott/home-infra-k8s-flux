-- Remap Gmail IMAP-keyword artifact folders and the no-label fallback into Archive,
-- recording the original folder as a `gmail-*` JMAP keyword on each message.
--
-- Runs inside one transaction. Verify the before/after report printed by
-- remap-artifacts-check.sql on either side of this.

BEGIN;

CREATE TEMP TABLE artifact_map (mailbox_id INTEGER PRIMARY KEY, keyword TEXT NOT NULL);

INSERT INTO artifact_map (mailbox_id, keyword)
SELECT m.id, k.keyword
FROM mailboxes m
JOIN (
            SELECT 'IMAP_$NotJunk'                     AS name, 'gmail-imap-$notjunk'      AS keyword
  UNION ALL SELECT 'IMAP_NotJunk',                             'gmail-imap-notjunk'
  UNION ALL SELECT 'IMAP_$Junk',                               'gmail-imap-$junk'
  UNION ALL SELECT 'IMAP_Junk',                                'gmail-imap-junk'
  UNION ALL SELECT 'IMAP_JunkRecorded',                        'gmail-imap-junkrecorded'
  UNION ALL SELECT 'IMAP_$Forwarded',                          'gmail-imap-$forwarded'
  UNION ALL SELECT 'IMAP_Forwarded',                           'gmail-imap-forwarded'
  UNION ALL SELECT 'IMAP_$MailFlagBit0',                       'gmail-imap-$mailflagbit0'
  UNION ALL SELECT 'IMAP_$MailFlagBit1',                       'gmail-imap-$mailflagbit1'
  UNION ALL SELECT 'IMAP_$MailFlagBit2',                       'gmail-imap-$mailflagbit2'
  UNION ALL SELECT '[Gmail]All Mail',                          'gmail-all-mail'
  UNION ALL SELECT 'Muted',                                    'gmail-muted'
  UNION ALL SELECT 'Chat',                                     'gmail-chat'
  UNION ALL SELECT 'All mail Including Spam and Trash',        'gmail-nolabel'
) k ON k.name = m.name;

-- Fail loudly rather than silently half-applying if the folder set is not what was
-- measured. The CHECK aborts the insert, and `sqlite3 -bail` then exits before COMMIT.
CREATE TEMP TABLE guard (n INTEGER CHECK (n = 14));
INSERT INTO guard SELECT count(*) FROM artifact_map;

-- 1. Add one gmail-* keyword per artifact folder the message belonged to.
--    Existing keywords ($seen, $important, $flagged) are preserved; UNION dedupes.
UPDATE emails
SET keywords = (
      SELECT json_group_array(kw)
      FROM (
                  SELECT value AS kw FROM json_each(emails.keywords)
        UNION     SELECT a.keyword
                  FROM json_each(emails.mailbox_ids) j
                  JOIN artifact_map a ON a.mailbox_id = j.value
        ORDER BY kw
      )
    )
WHERE EXISTS (
      SELECT 1 FROM json_each(emails.mailbox_ids) j
      JOIN artifact_map a ON a.mailbox_id = j.value
    );

-- 2. Drop the artifact mailboxes from each message's placement. A message left with
--    no placement at all lands in Archive (id 3) -- in Gmail it was All Mail, no label.
UPDATE emails
SET mailbox_ids = (
      SELECT CASE WHEN count(*) = 0
                  THEN json_array((SELECT id FROM mailboxes WHERE role = 'archive'))
                  ELSE json_group_array(value)
             END
      FROM json_each(emails.mailbox_ids)
      WHERE value NOT IN (SELECT mailbox_id FROM artifact_map)
    )
WHERE EXISTS (
      SELECT 1 FROM json_each(emails.mailbox_ids) j
      WHERE j.value IN (SELECT mailbox_id FROM artifact_map)
    );

-- 3. Remove the now-unreferenced mailboxes and their takeout sync mappings, so the
--    export does not re-create them as empty folders on the server.
DELETE FROM sync_id_takeout
WHERE type_name = 'mailbox'
  AND local_id IN (SELECT mailbox_id FROM artifact_map);

DELETE FROM mailboxes
WHERE id IN (SELECT mailbox_id FROM artifact_map);

COMMIT;
