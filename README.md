# RDTTrades

Trade log. (Still slightly WIP)

Workflow is: ToS -> Email -> Zapier -> Github ("Inbox" folder).

Use the "inbox/processed" folder as the absolute truth (raw files from ToS) - everything else is just processing.

Zapier may have a slight delay. Trades include the gmail timestamp (trade received from ToS) and the Zapier timestamp (trade sent to github from zapier).

week-to-date.json  = current week (Monday to Sunday) trades.
month-to-date.json = current calendar month's trades (e.g. Jan 1 - Jan 31st).
Access past months = trades/completed-trades-monthlylog

Bug note: Trades sometimes fail to process if made at the same time due to concurency errors.

Bug note #2: Zapier free often hits the 100 message (1 per entry, 1 per exit) limit per month; near end-of-month trades may not be recorded (resets on the 4th of every month). As a workaround, I will upload CSV files to the inbox occasionally for the remaining trades; obviously these trades will not be recorded in real-time and are less verifiable.

Note that on 11/03/2026 I did a few test trades (mostly using SPY) using arbritary numbers.
