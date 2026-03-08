# RDTTrades

Trade log. (Still slightly WIP)

Workflow is: ToS -> Email -> Zapier -> Github ("Inbox" folder).

Use the "Inbox" folder as the absolute truth (raw file from ToS) - everything else is just processing.

Zapier may have a slight delay.
"Timestamp" = Gmail timestamp (trade received from ToS).
"Time Received (Github)" = Zapier timestamp (trade sent to github from zapier).

week-to-date.json  = current week (Monday to Sunday) trades.
month-to-date.json = current calendar month's trades (e.g. Jan 1 - Jan 31st).
