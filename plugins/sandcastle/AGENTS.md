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
| board (Tickets, Lauf-Leiste) | tickets-leiste, tickets-leiste-zu, tickets-leiste-ziehen, tickets-lauf | gebaut („+ Neues Ticket“ offen: kein JIRA-Anlegen) |
| board (Neuer Lauf, v23) | tickets-neuer-lauf – alle Parameter (Batch/einzeln, Agent/Modell, Parallelität 1–6, Ziel-Branch, Testserver-Karten, Befehlsvorschau) | gebaut (Abweichungen: die Vorschau zeigt die echte Skill-Zeile vom Gate `preview` – `/skill:… warteschlange` bzw. Story-Nummern, Flags `--kein-testserver`/`--no-testnote`/`--testnote`/`--screencast`, `--ziel-branch` statt der Design-Flags; Batch/einzeln und „Feste Liste“ nur für eine Schleife ohne Warteschlangen-Modus mit mehr als einer Story) |
| board (Einreihen, v22) | tickets-einreihen, tickets-einreihen-ohne-story, tickets-einreihen-kein-lauf, tickets-einreihen-fertig; „▷ Lauf starten“ in der Leiste | gebaut (Abweichung: „Grillen“ nur, wenn das Ticket ein offenes Grill-Issue hat; Story ohne offene Kinder: „Keine offenen Kinder – nichts mehr zu bauen“) |
| laeufe (v23) | default, laeuft, wartet, start, leer, grills, hell – Statusblock je Rechner, „Was passiert gerade“-Zeitleiste | gebaut (Abweichungen: offline Rechner stehen ausgegraut am Ende; ohne Ablauf-Log zeigt die Zeitleiste Unbekanntes gestrichelt „ohne Angabe“ – nie einen geratenen Schritt – und darunter „Zuletzt vom Agenten“ aus dessen Sitzungslog (nicht im Design); die Wartezeile nennt die Station, nicht die konkrete Frage) |
| board (Lauf-Panel + Lauf-Leiste, v24) | tickets-lauf, tickets-lauf-merge; Komponenten run-details / run-dock mit Zustand ohne-log – Runde mit Planer → Kinder bauen → Merge im Kopf, Fortschritt in Kindern, je Story x/y gemergt mit Segmentbalken und aufklappbaren Kind-Zeilen, Chips „TENDR-1071 · 3/9 · 2 in Arbeit“ | gebaut (Abweichungen: Kinder einer Story sind ihre Issues in der Lane des Rechners; Pull Request ohne „Entwurf/offen“ (der Status kennt ihn nicht); Schloss und Pfeile hängen an der Phase der Story – im Lauf ohne Ablauf-Log bleiben Stories daher verschiebbar und die Chips durchgezogen statt gestrichelt; ohne Runde zeigt der Kopf „jetzt: …“ bzw. „Runde unbekannt“, nach der Schleife „Schleife fertig · jetzt: Prüfungen/PR/…“ ohne Rundenleiste; ab Durchgang 2 „· Durchgang N“ hinter der Runde) |
