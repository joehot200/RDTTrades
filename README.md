# RDTTrades

Trade log. (Still slightly WIP)

Workflow is: ToS -> Email -> Zapier -> Github (Inbox).

The workflow is then:
  Inbox -> month-to-date.json
        -> trades/entries-exits/[trade].json -> trades/completed-trades/[trade-pair].json
        -> (Or something like that, anyway.

Use the "Inbox" folder as the absolute truth (raw file from ToS) - everything else is just processing.

Zapier may have a slight delay.
"Timestamp" = Gmail timestamp (trade received from ToS).
"Time Received (Github)" = Zapier timestamp (trade sent to github from zapier).
