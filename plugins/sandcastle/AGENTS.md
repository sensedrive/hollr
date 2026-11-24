# Sandcastle plugin

- Design source of truth: magicfink project `sandcastle-board` (https://magicfink.finksmart.de/p/sandcastle-board).
  Every visible UI change goes there first (design request, `mode: "change"`), then into `ui/` to match the rendered frames.
  Logic without a visual effect may be built in parallel.
- Design ledger below: every state of the design is listed with its build status. A design request adds its new states
  as „offen“ right away; building one sets it to „gebaut“. Nothing designed stays invisible as „probably done“.
- Data contracts: server gate `sandcastle` (`server/src/sandcastle.ts`) for per-machine runs/queues/logs; this plugin's server does GitHub only.

## Design ledger (`sandcastle-board`)

| Screen | States | Status |
| --- | --- | --- |
| board (Werkbank) | normal, ziehen, laden, fehler, details, details-601, details-logs, neues-issue, kein-lauf, eingereiht, filter, menue, mehrere-laeufe, lanes-zu, grill-start, grill-laeuft, hell, werkbank | gebaut |
| board (Tickets) | tickets, tickets-typ, tickets-drift, tickets-live, tickets-live-details, tickets-teilweise-live-details, jira-fehlt, filter-logik | gebaut |
| board (Tickets, Lauf-Leiste) | tickets-leiste, tickets-leiste-zu, tickets-leiste-ziehen, tickets-lauf, tickets-neuer-lauf | gebaut („+ Neues Ticket“ offen: kein JIRA-Anlegen) |
| laeufe | laeuft, wartet, start, leer, grills | teilweise: Startformular immer offen statt hinter „Lauf starten“, Grill-Pane ohne STATUS-Protokoll-Liste, keine Vorauswahl |
