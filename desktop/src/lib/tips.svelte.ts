// "Neu und praktisch" (iOS TipsTour): after an update, page through what's new and where it hides.
// Shown once per tour version on start; again any time from Settings › Allgemein › Tipps & Tricks.
export interface Tip {
  id: string;
  icon: string;
  /** German source strings, translated at render time */
  title: string;
  text: string;
  /** first tour version that has it – the tour after an update starts with the new ones */
  since: number;
}

/** raise when the tour has new pages: it shows once more after the update */
export const TOUR_VERSION = 1;

export const TIPS: Tip[] = [
  { id: "inbox", icon: "☰", title: "Braucht dich", since: 1,
    text: "Oben auf der Startseite: Fragen von omp mit einem Klick beantworten, wartenden oder fertigen Agents direkt antworten." },
  { id: "notify", icon: "🔔", title: "Mitteilungen", since: 1,
    text: "Wartet ein Agent auf dich oder ist fertig, meldet sich Hollr mit einer Mitteilung – ein Klick öffnet den Chat. Abschaltbar unter Einstellungen › Allgemein." },
  { id: "keys", icon: "⌘", title: "Tastenkürzel", since: 1,
    text: "Im Chat: {mod}K Eingabe, {mod}⇧G Git & Dateien, {mod}⇧B Browser, {mod}⇧I Info, {mod}⇧M Modell, {mod}. bricht ab." },
  { id: "terminal", icon: ">_", title: "Terminal", since: 1,
    text: "{mod}⇧T wechselt zwischen Chat und dem Terminal der Session – derselbe Bildschirm wie am Rechner." },
  { id: "snippets", icon: "✚", title: "Bausteine und @", since: 1,
    text: "Über dem Eingabefeld stehen deine Prompt-Bausteine. „@“ schlägt Dateien aus dem Repo vor." },
  { id: "attach", icon: "📎", title: "Anhänge", since: 1,
    text: "Büroklammer, Einfügen oder einfach ins Eingabefeld ziehen: Bilder und Dateien gehen mit an den Agent." },
  { id: "review", icon: "✓", title: "Änderungen prüfen", since: 1,
    text: "Git & Dateien › Änderungen: Dateien stagen, verwerfen oder kommentieren. Unten: Commit, Push, PR." },
  { id: "folders", icon: "▢", title: "Ordner durchsuchen", since: 1,
    text: "Neue Sitzung oder neuer Space: „Durchsuchen …“ zeigt die Ordner des Servers, Git-Repos sind markiert. Tippen geht weiterhin." },
  { id: "setup", icon: "☑", title: "Einrichtung prüfen", since: 1,
    text: "Server-Info: was auf dem Server noch fehlt, mit „Installieren“, „Neu starten“ oder einem Befehl zum Kopieren." },
  { id: "zen", icon: "⤢", title: "Zen-Modus", since: 1,
    text: "{mod}⇧F: nur Verlauf und Eingabe – dein Entwurf bleibt beim Umschalten erhalten." },
  { id: "iphone", icon: "📱", title: "Unterwegs auf dem iPhone", since: 1,
    text: "Widgets, Siri, Live-Aktivität und Antworten aus der Mitteilung gibt es in der iPhone-App – mit denselben Servern." },
];

const SEEN_KEY = "hollr.tour.seenVersion";

const seenVersion = () => Number(localStorage.getItem(SEEN_KEY) ?? 0) || 0;

/** Tips for the tour after an update (new ones first), or null when there is nothing to show. */
export function pendingTips(): Tip[] | null {
  const seen = Number(localStorage.getItem(SEEN_KEY) ?? 0) || 0;
  if (seen >= TOUR_VERSION) return null;
  if (seen === 0) return TIPS;
  return [...TIPS.filter((t) => t.since > seen), ...TIPS.filter((t) => t.since <= seen)];
}

export function markTourSeen() {
  try {
    localStorage.setItem(SEEN_KEY, String(TOUR_VERSION));
  } catch {}
}

/** the open tour (null = closed) */
export const tour = $state<{ tips: Tip[] | null }>({ tips: null });

export const openTour = (tips: Tip[] = TIPS) => (tour.tips = tips);
