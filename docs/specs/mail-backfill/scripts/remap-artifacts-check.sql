-- Invariants for the artifact remap. Run before and after remap-artifacts.sql;
-- every line except the mailbox/keyword counts must be identical across the two runs.

SELECT 'total emails',            count(*) FROM emails
UNION ALL
SELECT 'emails with no mailbox',  count(*) FROM emails WHERE json_array_length(mailbox_ids) = 0
UNION ALL
SELECT 'distinct blobs referenced', count(DISTINCT blob_id) FROM emails
UNION ALL
SELECT 'mailboxes',               count(*) FROM mailboxes
UNION ALL
SELECT 'sync mailbox rows',       count(*) FROM sync_id_takeout WHERE type_name = 'mailbox'
UNION ALL
SELECT 'emails carrying gmail-*', count(*) FROM emails
  WHERE EXISTS (SELECT 1 FROM json_each(emails.keywords) j WHERE j.value LIKE 'gmail-%')
UNION ALL
SELECT 'emails in Archive',       count(*) FROM emails
  WHERE EXISTS (SELECT 1 FROM json_each(emails.mailbox_ids) j WHERE j.value = 3)
UNION ALL
SELECT 'calendar events',         count(*) FROM calendar_events;
