// Read aloud: selection button, stop pill, Settings → Vorlesen, speech.rs messages (German source → English).
export default {
  // selection button and pill
  Vorlesen: "Read aloud",
  "Markierung vorlesen ({key})": "Read selection aloud ({key})",
  "Stimme startet …": "Starting voice …",
  "Liest vor": "Reading aloud",
  "Vorlesen stoppen (Esc)": "Stop reading (Esc)",
  Systemstimme: "System voice",
  "Vorschau ohne Ton": "Preview without sound",
  "Nichts zum Vorlesen markiert.": "Nothing readable selected.",
  // spoken summary: selection button, pill, errors
  Zusammenfassung: "Summary",
  "Zusammenfassung vorlesen ({key})": "Read a summary aloud ({key})",
  "Fasse zusammen …": "Summarizing …",
  "schnelles Modell": "fast model",
  "Liest die Zusammenfassung": "Reading the summary",
  // reading panel
  Original: "Original",
  "Zusammenfassung vorlesen": "Read the summary",
  Nochmal: "Again",
  Langsamer: "Slower",
  Schneller: "Faster",
  "Einstellungen › Vorlesen": "Settings › Read aloud",
  "Schließen (Esc)": "Close (Esc)",
  "omp fasst den markierten Text zusammen …": "omp is summarizing the selected text …",
  "Tempo – gilt ab dem nächsten Vorlesen („Nochmal“ liest gleich im neuen Tempo)":
    "Speed – applies from the next reading (“Again” reads at the new speed right away)",
  "Tempo – Phonon liest etwa zwischen 0,8× und 1,3×, die Systemstimme im ganzen Bereich":
    "Speed – Phonon reads between about 0.8× and 1.3×, the system voice across the whole range",
  "Phonon liest etwa zwischen 0,8× und 1,3×, die Systemstimme im ganzen Bereich.":
    "Phonon reads between about 0.8× and 1.3×, the system voice across the whole range.",
  "Original vorlesen": "Read the original",
  "Dieser Server kann noch nicht zusammenfassen – Hollr auf dem Server aktualisieren.":
    "This server can't summarize yet – update Hollr on the server.",
  "Auf dem Server ist weder omp noch Claude Code installiert.": "Neither omp nor Claude Code is installed on the server.",
  "omp ist auf dem Server bei keinem Anbieter angemeldet.": "omp isn't logged in to any provider on the server.",
  "Die Zusammenfassung hat zu lange gedauert.": "The summary took too long.",
  "Das Modell hat keine Zusammenfassung geliefert.": "The model returned no summary.",
  "Zusammenfassung fehlgeschlagen: {error}": "Summary failed: {error}",
  "Zusammenfassen geht nur im Chat oder Terminal einer Sitzung.": "Summaries work in a session's chat or terminal only.",
  // settings
  "Wer liest vor": "Who reads",
  "Probe anhören": "Play a sample",
  "Nur in der App": "Only in the app",
  "Nichts verfügbar": "Nothing available",
  "Text im Chat oder Terminal markieren und auf „Vorlesen“ klicken oder {key} drücken; Esc stoppt. Die Sprache erkennt Hollr am Text, Code-Blöcke werden übersprungen.":
    "Select text in the chat or terminal and click “Read aloud” or press {key}; Esc stops. Hollr tells the language from the text and skips code blocks.",
  "Phonon, wenn ein geladenes Modell die Sprache spricht – sonst die Systemstimme.":
    "Phonon when a downloaded model speaks the language – otherwise the system voice.",
  "Immer die Systemstimme": "Always the system voice",
  "Nur auf dem Mac (say).": "Only on the Mac (say).",
  "macOS-Stimmen (say), ohne Download.": "macOS voices (say), no download.",
  "Phonon-Modelle": "Phonon models",
  "Modellseite in der Ollama-Registry": "Model page in the Ollama registry",
  "Deutsch, Englisch, Französisch, Spanisch, Portugiesisch – empfohlen": "German, English, French, Spanish, Portuguese – recommended",
  "Nur Deutsch": "German only",
  "Nur Englisch": "English only",
  "„Laden“ macht dort weiter.": "“Download” picks up where it stopped.",
  "Phonon von Gradium läuft auf diesem Computer (CPU, etwa 20× schneller als Echtzeit) und streamt, während es liest.":
    "Gradium's Phonon runs on this computer (CPU, about 20× faster than real time) and streams while it reads.",
  "Quelle: Ollama-Registry (library/phonon), ohne Anmeldung. Die Modelle stammen von Gradium – Phonon 40m unter CC BY-NC 4.0 (nur nicht-kommerziell), Phonon 31m unter Apache 2.0; die Lizenztexte liegen beim Modell im App-Ordner.":
    "Source: the Ollama registry (library/phonon), no sign-in. The models are by Gradium – Phonon 40m under CC BY-NC 4.0 (non-commercial only), Phonon 31m under Apache 2.0; the licence texts are stored with the model in the app folder.",
  "Stimme ({model})": "Voice ({model})",
  Standard: "Default",
  "Standard ({name})": "Default ({name})",
  weiblich: "female",
  männlich: "male",
  "Die Stimmen aus Gradiums Katalog sind im Modell enthalten – kein weiterer Download.":
    "The voices from Gradium's catalog come with the model – nothing more to download.",
  Tempo: "Speed",
  "Dieses Phonon-Modell liest immer im eigenen Tempo.": "This Phonon model always reads at its own pace.",
  "Knöpfe „Vorlesen“ und „Zusammenfassung“ bei markiertem Text": "“Read aloud” and “Summary” buttons next to selected text",
  // settings: summary
  "Server (Modelle und Test)": "Server (models and test)",
  Konto: "Account",
  "omp wechselt zwischen diesen Konten": "omp rotates through these accounts",
  "Automatisch ({name})": "Automatic ({name})",
  "Automatisch (schnelles Modell)": "Automatic (fast model)",
  "nicht auf diesem Server": "not on this server",
  Länge: "Length",
  "kurz (2–3 Sätze)": "short (2–3 sentences)",
  "mittel (5–7 Sätze)": "medium (5–7 sentences)",
  "Zusammenfassung, danach Original": "Summary, then the original",
  "Liest nach der Zusammenfassung gleich den markierten Text vor.": "Reads the selected text right after the summary.",
  Probe: "Test",
  "Fasst einen Beispieltext zusammen und zeigt das Ergebnis.": "Summarizes a sample text and shows the result.",
  Testen: "Test",
  "aus dem Zwischenspeicher": "from the cache",
  "Auf keinem Server ist omp installiert.": "omp isn't installed on any server.",
  "„Zusammenfassung“ neben markiertem Text oder {key}: omp fasst den Text auf dem Server der Sitzung zusammen – mit diesem Modell und dem Konto, mit dem omp dort angemeldet ist –, danach wird vorgelesen. Ohne Werkzeuge, ohne gespeicherte Sitzung.":
    "“Summary” next to selected text or {key}: omp summarizes the text on the session's server – with this model and the account omp is logged in with there – and the summary is read aloud. No tools, no saved session.",
  // speech.rs
  "Kein Phonon-Modell für diese Sprache und keine Systemstimme – Einstellungen › Vorlesen.":
    "No Phonon model for this language and no system voice – Settings › Read aloud.",
  "Keine Systemstimme – ein Phonon-Modell laden (Einstellungen › Vorlesen).": "No system voice – download a Phonon model (Settings › Read aloud).",
  "Download beschädigt (Prüfsumme stimmt nicht)": "Download corrupted (checksum mismatch)",
  "Kein Lautsprecher gefunden": "No speaker found",
  "Lautsprecher getrennt": "Speaker disconnected",
};
