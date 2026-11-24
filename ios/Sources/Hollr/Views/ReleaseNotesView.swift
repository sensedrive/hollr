import SwiftUI

/// What came when (Settings → Neuigkeiten). Newest first; add an entry with every build.
struct ReleaseNote: Identifiable {
    let build: Int
    let date: String
    let items: [(icon: String, text: String)]
    var id: Int { build }
}

enum ReleaseNotes {
    static let all: [ReleaseNote] = [
        ReleaseNote(build: 73, date: "24.11.2026", items: [
            ("text.bubble", String(localized: "Diktat: der Text erscheint jetzt schon beim Sprechen, nicht erst nach einer Pause")),
        ]),
        ReleaseNote(build: 72, date: "24.11.2026", items: [
            ("bolt", String(localized: "Übersicht: „Läuft gerade“ startet mit „Arbeitet“")),
        ]),
        ReleaseNote(build: 71, date: "24.11.2026", items: [
            ("mic", String(localized: "Diktat als eigener Bildschirm: einmal antippen, live mitlesen, großer Knopf zum Pausieren, ✓ beendet – danach Text bearbeiten und senden")),
            ("checkmark.seal", String(localized: "Whisper-Modelle bleiben nach App-Updates geladen – kein „noch nicht geladen“ mehr")),
            ("internaldrive", String(localized: "Einstellungen › Sprache zeigt, welche Modelle auf dem iPhone sind, wie groß sie sind und welches gerade diktiert")),
        ]),
        ReleaseNote(build: 70, date: "24.11.2026", items: [
            ("link", String(localized: "Tickets (z. B. TENDR-1037) und Issues/PRs (#3575) in Chat und Terminal antippen – öffnet das Sandcastle-Board direkt auf dem Ticket")),
        ]),
        ReleaseNote(build: 69, date: "24.11.2026", items: [
            ("mic", String(localized: "Diktieren neu: einmal aufs Mikrofon tippen, nicht mehr halten – großer Knopf in der Mitte zum Pausieren, Senden daneben, der Text erscheint live")),
            ("clock", String(localized: "„Zuletzt“ zeigt, wann sich jeder Agent zuletzt gemeldet hat")),
        ]),
        ReleaseNote(build: 68, date: "24.11.2026", items: [
            ("rectangle.compress.vertical", String(localized: "„Braucht dich“: neue Ergebnisse als schmale Karte in zwei Zeilen – Antworten, Terminal und Gesehen direkt in der Zeile")),
        ]),
        ReleaseNote(build: 67, date: "24.11.2026", items: [
            ("clock", String(localized: "Übersicht: „Zuletzt“ statt „Alle“ – alle Agenten in einer Liste, wer zuletzt etwas gemeldet hat, steht oben; arbeitende zeigen, seit wann")),
            ("checkmark.circle", String(localized: "Sitzungen auf Servern zeigen wieder, dass sie arbeiten")),
        ]),
        ReleaseNote(build: 66, date: "23.11.2026", items: [
            ("arrow.clockwise", String(localized: "Plugins verbinden sich selbst neu, wenn ihr Dienst auf dem Rechner neu gestartet wurde")),
        ]),
        ReleaseNote(build: 65, date: "23.11.2026", items: [
            ("key", String(localized: "Einstellungen › Integrationen: JIRA-Zugang einmal eintragen, Hollr hinterlegt ihn auf allen Rechnern")),
        ]),
        ReleaseNote(build: 64, date: "23.11.2026", items: [
            ("flame", String(localized: "Sandcastle-Board: Tickets grillen oder auto-grillen; Chat-Menü › „Im Board zeigen“ bei Grill-Sitzungen")),
        ]),
        ReleaseNote(build: 63, date: "23.11.2026", items: [
            ("circle.lefthalf.filled", String(localized: "Plugins übernehmen das Farbschema von Hollr samt Hell/Dunkel")),
        ]),
        ReleaseNote(build: 62, date: "23.11.2026", items: [
            ("list.bullet.rectangle", String(localized: "Sandcastle-Plugin 2: Schnellfilter, Warteschlange je Rechner und die neue Ansicht „Läufe“ mit Logs – auch auf dem iPhone")),
        ]),
        ReleaseNote(build: 61, date: "22.11.2026", items: [
            ("checkmark.circle", String(localized: "Behoben: Absturz kurz nach dem Öffnen, wenn sich Listen (Spaces, Agents) gleichzeitig änderten")),
        ]),
        ReleaseNote(build: 60, date: "22.11.2026", items: [
            ("desktopcomputer", String(localized: "Dieselben Rechner auf allen Geräten: was auf dem Mac gekoppelt ist, koppelt sich hier von selbst – und Entfernen gilt überall")),
            ("arrow.up.arrow.down", String(localized: "Spaces anordnen: „Anordnen“ oben in Spaces – die Reihenfolge ist auf Mac und iPhone gleich; Prompt-Bausteine und Diktat-Vokabular ebenso")),
            ("checkmark.circle", String(localized: "Behoben: Absturz in der Spaces-Liste, wenn ein versteckter Space auf dich wartete")),
        ]),
        ReleaseNote(build: 59, date: "22.11.2026", items: [
            ("arrow.triangle.2.circlepath", String(localized: "„Braucht dich“, gesehene Ergebnisse, „Als ungelesen markieren“, „Meine Sitzungen“ und die Reihenfolge der Spaces sind jetzt auf iPhone und Mac gleich")),
            ("stethoscope", String(localized: "Hollr schreibt ein kurzes Protokoll und schickt es an deinen Rechner – damit lassen sich Fehler wie ein weißer Bildschirm finden")),
        ]),
        ReleaseNote(build: 58, date: "22.11.2026", items: [
            ("eye.slash", String(localized: "Spaces verstecken: nach links wischen oder lange drücken – unter „Versteckt“ aufklappen, zurückholen oder beenden")),
            ("arrow.left.arrow.right", String(localized: "Was versteckt ist, merkt sich der Server – iPhone und Mac zeigen immer dieselben Spaces")),
        ]),
        ReleaseNote(build: 57, date: "22.11.2026", items: [
            ("bolt.horizontal", String(localized: "Zurück aus dem Hintergrund lädt der Chat sofort – vorher blieb er bis zu einer Minute auf dem Platzhalter")),
        ]),
        ReleaseNote(build: 56, date: "21.11.2026", items: [
            ("paintpalette", String(localized: "Der Chat hat Farben wie am Mac: fett und Überschriften lila, Code grün, Tabellenköpfe gelb – in jedem Farbschema gut lesbar")),
            ("checkmark.bubble", String(localized: "Ein einzelner unlesbarer Eintrag lässt nicht mehr den ganzen Chat leer – und „Arbeitet …“ verschwindet, wenn der Agent wirklich fertig ist")),
            ("arrow.triangle.2.circlepath", String(localized: "Chat und Terminal frieren nach Netzwechsel oder Hintergrund nicht mehr ein; „Nicht gesendet“ bleibt stehen, bis du es erledigt hast")),
        ]),
        ReleaseNote(build: 55, date: "21.11.2026", items: [
            ("checkmark.bubble", String(localized: "Chats mit einem abgeschnittenen Emoji im Verlauf laden wieder – vorher blieb der Chat leer, nur das Terminal ging")),
        ]),
        ReleaseNote(build: 54, date: "21.11.2026", items: [
            ("arrow.triangle.2.circlepath", String(localized: "Nach einem Netzwechsel (Tailscale wieder da, WLAN ↔ Mobilfunk) verbindet sich Hollr sofort neu – vorher hing es bis zu einer Minute")),
            ("exclamationmark.bubble", String(localized: "Eine Nachricht ohne Verbindung zeigt „Nicht gesendet“ – mit „Erneut senden“ und „Verwerfen“, statt still im Chat zu stehen")),
            ("plus.rectangle", String(localized: "Neue Sitzung öffnet ein Terminal – omp, Claude Code & Co. startest du dort selbst")),
            ("puzzlepiece", String(localized: "Neu: Plugins – Erweiterungen deines Servers mit eigener Oberfläche, zum Beispiel das Sandcastle-Board")),
        ]),
        ReleaseNote(build: 48, date: "30.10.2026", items: [
            ("link", String(localized: "Im Terminal: ein Tipp auf eine Adresse öffnet sie – im Hollr-Browser oder in Safari (auch localhost:PORT)")),
            ("character.cursor.ibeam", String(localized: "Im Terminal lange drücken: Text auswählen und kopieren – das Wort unter dem Finger ist schon markiert, Links darin öffnen ebenfalls")),
            ("arrow.triangle.2.circlepath", String(localized: "Terminal verbindet sich selbst neu, wenn die Verbindung abbricht (Netzwechsel, zurück aus dem Hintergrund) – kein Fehler mit „Neu verbinden“ mehr")),
        ]),
        ReleaseNote(build: 47, date: "29.10.2026", items: [
            ("speaker.wave.2", String(localized: "Live: omps Stimme ist jetzt wirklich zu hören – nach dem Umschalten aufs Telefonat blieb die Wiedergabe stumm, bis man den Ton aus- und wieder einschaltete")),
            ("speaker.wave.3", String(localized: "Live mit einem Mac: omp kommt in voller Lautstärke an, auch wenn am Mac während eines Anrufs die Lautstärke verstellt wurde")),
        ]),
        ReleaseNote(build: 46, date: "29.10.2026", items: [
            ("speaker.wave.2", String(localized: "Live mit omp auf einem Mac: du hörst omp wieder – seine Stimme kam bisher als Stille an, weil macOS per SSH gestarteten Programmen keine Aufnahme erlaubt")),
            ("questionmark.bubble", String(localized: "Fragen von omp: ein Tipp wählt genau diese Antwort – vorher landete die Auswahl daneben, sobald omp eine Option empfahl")),
            ("checklist", String(localized: "Mehrere Fragen auf einmal und Mehrfachauswahl lassen sich im Chat beantworten, mit eigener Antwort pro Frage")),
            ("pencil", String(localized: "Eigene Antwort auf eine Frage: einfach unten eintippen – auch in „Braucht dich“ und in der Mitteilung")),
            ("space", String(localized: "Tasten senden: jetzt auch die Leertaste")),
        ]),
        ReleaseNote(build: 45, date: "16.10.2026", items: [
            ("apple.terminal", String(localized: "Neu: jede Session nativ als Terminal – omp, Claude, Codex und Shells zeigen ihre echte Oberfläche, in iPhone-Breite (Knopf oben rechts: Chat ↔ Terminal)")),
            ("hand.draw", String(localized: "Im Terminal scrollt Wischen die Oberfläche des Agents – wie mit dem Trackpad am Rechner")),
        ]),
        ReleaseNote(build: 44, date: "15.10.2026", items: [
            ("hand.tap", String(localized: "In der Agents-Liste öffnet ein Tipp den Chat wieder (seit Build 39 kaputt)")),
        ]),
        ReleaseNote(build: 43, date: "15.10.2026", items: [
            ("gauge.with.dots.needle.33percent", String(localized: "Limit-Leiste: „ChatGPT“ wird nicht mehr abgeschnitten – wird es eng, rückt die Leiste zusammen")),
            ("desktopcomputer", String(localized: "Hollr Desktop: der Chat kommt jetzt ebenfalls als Datenstrom – sofort und nur mit den Änderungen")),
        ]),
        ReleaseNote(build: 42, date: "15.10.2026", items: [
            ("bolt.horizontal", String(localized: "Live-Chat als Datenstrom: neue Schritte erscheinen sofort, statt alle 1,5 s abgefragt zu werden – und es kommen nur die Änderungen (wenige KB statt ~100 KB)")),
            ("arrow.up.and.down.text.horizontal", String(localized: "Hochscrollen bleibt stehen: neue Ausgaben ziehen dich nicht mehr nach unten, „↓ Neu“ springt zurück ans Ende")),
            ("rectangle.bottomthird.inset.filled", String(localized: "Das Eingabefeld schwebt jetzt auch im normalen Modus durchsichtig über dem Chat")),
            ("star", String(localized: "Fragen von omp zeigen die empfohlene Antwort und die Erklärungen zu jeder Option – auch in „Braucht dich“ und Mitteilungen (★)")),
            ("arrow.up.left.and.arrow.down.right", String(localized: "Zen-Modus im halb geöffneten Chat öffnet ihn ganz – keine Darstellungsfehler mehr")),
        ]),
        ReleaseNote(build: 41, date: "15.10.2026", items: [
            ("apple.terminal", String(localized: "Terminal › „Eigene Shell“: ein echtes Terminal im Ordner der Session, passend zur iPhone-Breite, mit Scrollen – der Rechner bleibt unverändert")),
            ("keyboard", String(localized: "Tippen, Einfügen und Diktieren im Terminal laufen jetzt über die normale iOS-Tastatur")),
            ("gauge.with.dots.needle.33percent", String(localized: "Limit-Leiste: mehrere Server mit demselben Login zählen nur einmal – keine abgeschnittenen Einträge mehr")),
        ]),
        ReleaseNote(build: 40, date: "15.10.2026", items: [
            ("checklist", String(localized: "Server › Einrichtung: was noch fehlt, mit „Installieren“, „Neu starten“ oder „Push einrichten“ – der Push-Schlüssel lässt sich von einem anderen Server übernehmen")),
            ("bell.slash", String(localized: "Fehlt auf einem Server der Push, zeigt die Übersicht es an")),
            ("apple.terminal", String(localized: "Terminal lesbar: breite Terminals zeigen rund 100 Spalten in normaler Größe – zur Seite wischen oder auf ganze Breite schalten")),
            ("rectangle.landscape.rotate", String(localized: "iPhone quer: links der Chat, rechts Terminal oder Änderungen")),
            ("lightbulb", String(localized: "Tipps & Tricks: nach Updates zeigt Hollr kurz, was neu ist und wo es sich versteckt (auch in den Einstellungen)")),
        ]),
        ReleaseNote(build: 39, date: "15.10.2026", items: [
            ("apple.terminal", String(localized: "Echtes Terminal: Menü › Terminal zeigt die Session live in Farbe, mit Tastenleiste (esc, tab, ctrl, Pfeile) – zum Hineinzoomen aufziehen")),
            ("text.badge.plus", String(localized: "Prompt-Bausteine über der Tastatur und „@“ schlägt Dateien aus dem Repo vor (Einstellungen › Prompt-Bausteine)")),
            ("paperclip", String(localized: "Anhänge: Foto, Bildschirmfoto, Datei oder Bild aus der Zwischenablage an den Agent – und „Teilen › Hollr“ aus Safari, Mail oder Fotos")),
            ("checkmark.circle", String(localized: "Änderungen prüfen: wischen zum Stagen, Verwerfen oder Kommentieren, dann Commit (oder vom Agent schreiben lassen), Push und PR")),
            ("square.grid.2x2", String(localized: "Widgets für Home- und Sperrbildschirm (Agents, Limits) und Kurzbefehle/Siri: „Frag … in Hollr“, „Live starten“")),
            ("paintbrush", String(localized: "Ruhigerer Chat: Werkzeuge als eine Zeile zusammengefasst, Farbe pro Workspace, Zoom von der Karte in den Chat")),
            ("rectangle.split.2x1", String(localized: "Mac: Agents in der Seitenleiste, zwei Chats nebeneinander (Rechtsklick › Rechts daneben öffnen)")),
        ]),
        ReleaseNote(build: 38, date: "15.10.2026", items: [
            ("tray.full", String(localized: "Neu auf der Startseite: „Braucht dich“ – Fragen von omp mit einem Tipp beantworten, wartenden oder fertigen Agents direkt antworten")),
            ("bell.badge", String(localized: "Antworten direkt aus der Mitteilung: lange drücken für die Antwort-Optionen oder eine eigene Antwort")),
            ("platter.filled.bottom.iphone", String(localized: "Live-Aktivität: arbeitende Agents auf dem Sperrbildschirm und in der Dynamic Island – Schritt, Fortschritt, Laufzeit, orange wenn sie auf dich warten")),
        ]),
        ReleaseNote(build: 37, date: "15.10.2026", items: [
            ("doc.text", String(localized: "Entwürfe gehen nicht mehr verloren: Zen-Modus, Chat-Wechsel oder App-Neustart behalten den getippten Text – pro Chat")),
            ("waveform", String(localized: "Ein Diktat läuft beim Umschalten in den Zen-Modus weiter und landet im richtigen Chat")),
            ("wifi.exclamationmark", String(localized: "Nach Ruhezustand oder Netzwechsel hängt nichts mehr minutenlang – tote Verbindungen werden erkannt und neu aufgebaut")),
            ("phone.connection", String(localized: "Live erkennt Verbindungsabbrüche und zeigt, warum ein Anruf endete")),
            ("mic", String(localized: "Mikrofon-Knopf bleibt nach einem Anruf oder einer Abfrage nicht mehr hängen, kein Doppelstart")),
            ("square.stack.3d.up", String(localized: "Spaces: Chat-Wechsel und „Chat schließen“ funktionieren, Koppeln per Code wartet auf die Netzwerk-Freigabe")),
        ]),
        ReleaseNote(build: 36, date: "15.10.2026", items: [
            ("ladybug", String(localized: "Absturz beim Öffnen mancher Chats behoben (Cursor-Position im Eingabefeld)")),
        ]),
        ReleaseNote(build: 35, date: "14.10.2026", items: [
            ("waveform", String(localized: "Diktat mit Parakeet und Whisper erkennt schon beim Sprechen – nach dem Stopp ist der Text fast sofort da")),
            ("hand.tap", String(localized: "Mikrofon gedrückt halten zum Diktieren, ✕ verwirft die Aufnahme, Diktat landet an der Cursor-Position")),
            ("text.magnifyingglass", String(localized: "Projekt, Tickets und Dateinamen aus dem Chat werden besser erkannt und richtig geschrieben (z. B. TENDR-725)")),
            ("paperplane", String(localized: "„… senden“ am Ende schickt die Nachricht ab")),
            ("scissors", String(localized: "„ähm“ und „äh“ fliegen raus, erfundene Untertitel bei Stille auch")),
            ("phone.arrow.down.left", String(localized: "Anruf, App-Wechsel oder AirPods weg: das Diktat stoppt sauber und behält das Gesagte")),
            ("slider.horizontal.3", String(localized: "Neu in Einstellungen › Sprache: Rauschfilter, immer iPhone-Mikrofon, Feinschliff mit Apple Intelligence (Beta)")),
        ]),
        ReleaseNote(build: 34, date: "14.10.2026", items: [
            ("bolt", String(localized: "Deutlich flüssiger: der Chat lädt nur noch, was sich geändert hat, und reagiert sofort auf Antworten")),
            ("mic", String(localized: "Während des Diktierens pausiert der Chat, damit die Spracherkennung die volle Leistung hat")),
            ("moon.zzz", String(localized: "Ein schlafender Rechner bremst die anderen Server nicht mehr aus")),
        ]),
        ReleaseNote(build: 33, date: "14.10.2026", items: [
            ("folder", String(localized: "Neuer Space: Ordner auf dem Server durchsuchen – Projekte und Git-Repos auf einen Blick")),
        ]),
        ReleaseNote(build: 32, date: "14.10.2026", items: [
            ("questionmark.bubble", String(localized: "Fragen von omp: keine doppelte Terminal-Ansicht mehr über der Frage, dazu „Eigene Antwort“")),
        ]),
        ReleaseNote(build: 31, date: "14.10.2026", items: [
            ("keyboard", String(localized: "Koppeln per Einmalcode: Code vom Rechner eintippen oder einsetzen – ideal von unterwegs über Tailscale")),
        ]),
        ReleaseNote(build: 30, date: "14.10.2026", items: [
            ("globe", String(localized: "Fernzugriff über Tailscale: den Rechner auch von unterwegs erreichen – ohne offene Ports")),
            ("wifi", String(localized: "Verbindungsart pro Server: Lokales Netzwerk oder Tailscale, jederzeit umstellbar – mit Status „verbunden über …“")),
            ("checkmark.shield", String(localized: "Sicherer koppeln: der Rechner fragt nach, bevor ein gescannter Code ein Gerät freischaltet")),
        ]),
        ReleaseNote(build: 29, date: "14.10.2026", items: [
            ("waveform", String(localized: "Live-Sprache jetzt auch mit Macs als Server (einmalig BlackHole installieren, siehe Server-Info)")),
            ("arrow.clockwise", String(localized: "Nutzungslimits laden beim Öffnen frisch und lassen sich jederzeit neu laden")),
        ]),
        ReleaseNote(build: 28, date: "14.10.2026", items: [
            ("clock", String(localized: "Nutzungslimits: Reset auf die Minute genau (z. B. „in 4 Std., 23 Min.“)")),
        ]),
        ReleaseNote(build: 27, date: "14.10.2026", items: [
            ("chart.xyaxis.line", String(localized: "Verlauf & Statistik (Beta): Nutzungslimits über die Zeit, Verbrauch pro Tag und Agent-Zeit pro Maschine")),
            ("checkmark.circle", String(localized: "Nutzungslimits ohne doppelte Einträge")),
        ]),
        ReleaseNote(build: 26, date: "14.10.2026", items: [
            ("bolt.horizontal", String(localized: "Echtzeit: Neue Workspaces, Tabs und Agent-Status erscheinen sofort – ohne ständiges Nachladen")),
        ]),
        ReleaseNote(build: 25, date: "14.10.2026", items: [
            ("server.rack", String(localized: "Server & Geräte: jede Maschine mit eigener Seite – Auslastung, Probleme, Updates auf einen Blick")),
            ("arrow.down.circle", String(localized: "Werkzeuge: alles Fehlende und Veraltete mit einem Tipp installieren")),
            ("laptopcomputer", String(localized: "Macs als Server: Werkzeuge, Server-Info und Ports funktionieren jetzt auch dort")),
        ]),
        ReleaseNote(build: 24, date: "14.10.2026", items: [
            ("terminal", String(localized: "Server einrichten jetzt mit einem einzigen Befehl – ohne Extras")),
        ]),
        ReleaseNote(build: 23, date: "14.10.2026", items: [
            ("lock.open", String(localized: "Hollr ist Open Source (MIT) – github.com/sensedrive/hollr")),
            ("qrcode", String(localized: "Server einrichten mit einem curl-Befehl – kein GitHub-Login mehr nötig")),
            ("desktopcomputer", String(localized: "Desktop-App für Linux und Mac mit Live-Sprache und Git-Ansichten")),
        ]),
        ReleaseNote(build: 21, date: "14.10.2026", items: [
            ("globe", String(localized: "Hollr spricht jetzt Deutsch und Englisch")),
            ("rectangle.dashed", String(localized: "Skeletons statt Lade-Kreisel")),
            ("macbook", String(localized: "Hollr für den Mac (DMG) – koppeln per Link aus hollr pair --link")),
        ]),
        ReleaseNote(build: 20, date: "14.10.2026", items: [
            ("cpu", String(localized: "Modell und Thinking/Effort gleich beim Start einer Sitzung wählen – mit Suche und zuletzt genutzten Modellen")),
            ("arrow.left.arrow.right", String(localized: "Modell schnell wechseln: Statuszeile antippen oder ⋯ → Modell wechseln (omp nur für die Sitzung)")),
        ]),
        ReleaseNote(build: 18, date: "14.10.2026", items: [
            ("shippingbox", String(localized: "Werkzeuge zeigen die Zielversion, „Aktuell“ und ein ein-/ausklappbares Protokoll")),
            ("xmark.bin", String(localized: "Space schließen mit allen Optionen: nur schließen, Worktree entfernen, Worktree und Branch löschen (auch auf origin), Ordner löschen – vorher siehst du offene Änderungen und nicht gepushte Commits")),
        ]),
        ReleaseNote(build: 17, date: "14.10.2026", items: [
            ("gauge.with.dots.needle.67percent", String(localized: "Server-Info: Auslastung, Prozesse und ob der Server korrekt eingerichtet ist")),
            ("faceid", String(localized: "Optional mit Face ID sperren")),
            ("sparkles", "Neuigkeiten in den Einstellungen"),
            ("paintpalette", String(localized: "Designs: Dracula, Nord, Solarized, Gruvbox, Catppuccin, GitHub und mehr – hell, dunkel oder automatisch")),
            ("doc.on.doc", String(localized: "Server koppeln: kopierbare Befehle für Linux und macOS")),
        ]),
        ReleaseNote(build: 16, date: "14.10.2026", items: [
            ("waveform", String(localized: "Live klappt jetzt schon beim ersten Anruf")),
            ("speaker.slash", String(localized: "Ton aus: Antwort stummschalten, ohne aufzulegen")),
            ("mic.slash", String(localized: "Mikro aus lässt die Antwort weiterlaufen")),
            ("arrow.left.and.right", String(localized: "Verlauf lässt sich seitlich scrollen")),
        ]),
        ReleaseNote(build: 15, date: "14.10.2026", items: [
            ("arrow.triangle.branch", String(localized: "Git: Dateien, Änderungen mit Diff, Verlauf-Graph, Branches mit PR-Status")),
            ("shippingbox", String(localized: "herdr, omp, Claude Code, Codex und Hollr direkt aus der App installieren und aktualisieren")),
            ("key", String(localized: "Push-Schlüssel einmal in der App importieren – alle Server werden automatisch eingerichtet")),
        ]),
        ReleaseNote(build: 14, date: "14.10.2026", items: [
            ("bell.badge", String(localized: "Push-Mitteilungen, wenn ein Agent wartet, fertig ist oder einen Fehler hat")),
            ("terminal", String(localized: "Terminals starten – auch ohne Projekt im Home-Verzeichnis")),
            ("square.grid.2x2", String(localized: "Übersicht zeigt deine Sitzungen, gruppiert nach Maschine")),
        ]),
        ReleaseNote(build: 13, date: "14.10.2026", items: [
            ("globe", String(localized: "Browser zeigt auch localhost-Seiten des Servers – über SSH, ohne Zusatzdienst")),
        ]),
        ReleaseNote(build: 12, date: "14.10.2026", items: [
            ("safari", String(localized: "Eingebauter Browser; Links fragen: Hollr-Browser oder Safari")),
        ]),
        ReleaseNote(build: 11, date: "13.10.2026", items: [
            ("text.alignleft", String(localized: "Verlauf wie omps Terminal – ruhiger, kompakter")),
            ("rectangle.expand.vertical", String(localized: "Zen-Modus: nur Chat und durchsichtige Eingabe")),
        ]),
        ReleaseNote(build: 10, date: "13.10.2026", items: [
            ("keyboard.chevron.compact.down", String(localized: "Tastatur schließen, schließt nach dem Senden von selbst")),
            ("textformat.size", String(localized: "Ganze App skalieren – auch per Zwei-Finger-Geste")),
        ]),
        ReleaseNote(build: 9, date: "13.10.2026", items: [
            ("square.stack.3d.up", String(localized: "Spaces: Repos und Worktrees, Git-Verlauf und Dateien; Spaces anlegen und löschen")),
            ("chart.bar", String(localized: "Nutzungslimits von Claude und ChatGPT")),
        ]),
        ReleaseNote(build: 1, date: "Oktober 2026", items: [
            ("qrcode", String(localized: "Server per QR-Code koppeln – nur SSH, kein Zusatzdienst")),
            ("waveform.circle", String(localized: "omp /live vom iPhone: echtes Gespräch mit deinen Agents auf dem Server")),
            ("mic", String(localized: "Lokale Spracheingabe mit Parakeet, Whisper und Apple – mehrsprachig, mit Fachwörtern")),
            ("bubble.left.and.text.bubble.right", String(localized: "omp, Claude Code und Codex öffnen, lesen, schreiben und schließen")),
        ]),
    ]

    static var currentBuild: Int {
        Int(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "") ?? 0
    }

    private static let seenKey = "releaseNotes.seenBuild"
    static var hasUnseen: Bool { UserDefaults.standard.integer(forKey: seenKey) < (all.first?.build ?? 0) }
    static func markSeen() { UserDefaults.standard.set(all.first?.build ?? 0, forKey: seenKey) }
}

struct ReleaseNotesView: View {
    var body: some View {
        List {
            Group {
            ForEach(ReleaseNotes.all) { note in
                Section {
                    ForEach(Array(note.items.enumerated()), id: \.offset) { _, item in
                        Label {
                            Text(item.text).font(Typo.md)
                        } icon: {
                            Image(systemName: item.icon).foregroundStyle(Theme.muted)
                        }
                    }
                } header: {
                    // section label (uppercase 11 pt muted) with the "installiert" badge and the date on the right
                    HStack(spacing: Gap.s) {
                        Text(note.build == 1 ? "Anfang" : "Build \(note.build)")
                            .textCase(.uppercase)
                            .tracking(0.6)
                            .foregroundStyle(Theme.muted)
                        if note.build == ReleaseNotes.currentBuild {
                            Text("installiert").font(Typo.xs.weight(.semibold))
                                .foregroundStyle(Theme.accent)
                                .padding(.horizontal, Gap.s).padding(.vertical, 1)
                                .background(Theme.accent.opacity(0.18), in: Capsule())
                        }
                        Spacer(minLength: Gap.s)
                        Text(verbatim: note.date).monospacedDigit().foregroundStyle(Theme.dim)
                    }
                    .font(Typo.xs)
                    .textCase(nil)
                    .padding(.top, Gap.s)
                    .accessibilityAddTraits(.isHeader)
                }
            }
        }
            .listRowBackground(Theme.card)
        }.themedList()
        .navigationTitle("Neuigkeiten")
        .onAppear { ReleaseNotes.markSeen() }
    }
}
