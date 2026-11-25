## Parent
#266

## JIRA
HOF-356 — https://hofladen.atlassian.net/browse/HOF-356

## Was gebaut wird

Erster von zwei Bauaufträgen zu HOF-356 (Spec #264, Entscheidung ADR-0010). Das CMS lehnt beim Veröffentlichen einen Kurznamen ab, der in derselben Sprache schon vergeben ist: bei Seiten unter derselben Elternseite (auch „ohne Elternseite“), bei Meldungen, Stellen und Terminen in der ganzen Sammlung, weil deren Adressen flach sind. Die Meldung erscheint am Feld „Kurzname“ und nennt den anderen Eintrag. Entwürfe, auch die automatischen alle halbe Sekunde, lassen sich weiter speichern. Die Seiten des geschützten Bereichs bleiben ohne Prüfung (ADR-0005).

Szenario: Jemand kopiert die Seite „Gemüsekisten“, übersetzt die englische Fassung der Kopie als „Vegetable Boxes“ und klickt auf Veröffentlichen. Das CMS veröffentlicht nicht und zeigt am Kurznamen: der Kurzname `vegetable-boxes` ist unter dieser Elternseite auf Englisch schon von „Vegetable Boxes“ belegt. Heute wird die Kopie stillschweigend veröffentlicht und verdeckt das Original.

## Akzeptanzkriterien
- [ ] Der rote Diagnosetest unten liegt als `apps/cms/src/collections/Pages/pages.slug-uniqueness.int.test.ts` im Repo und ist vollständig grün: `yarn workspace @hofladen/cms vitest run src/collections/Pages/pages.slug-uniqueness.int.test.ts` (Test-Datenbank aus `yarn dc:up`, wie in der CI). Heute rot mit `Tests  3 failed | 3 passed (6)`, die drei roten Fälle mit `promise resolved … instead of rejecting`. Die Erwartungen des Tests werden nicht abgeschwächt; nur sein Aufbau darf an die gebaute Schnittstelle angepasst werden.
- [ ] Für Meldungen, Stellen und Termine gibt es denselben Nachweis gegen die Test-Datenbank: Eine zweite veröffentlichte Meldung mit demselben englischen Kurznamen wird mit einem Fehler am Feld `slug` abgelehnt, derselbe Kurzname in der anderen Sprache bleibt erlaubt, ein Entwurf mit vergebenem Kurznamen lässt sich speichern.
- [ ] Die Seiten des geschützten Bereichs (`protected-pages`) verhalten sich unverändert: zwei Seiten mit demselben Kurznamen lassen sich weiterhin veröffentlichen.
- [ ] Die Meldung ist zweisprachig (de/en) wie die übrigen Feldtexte und nennt den Titel des anderen Eintrags in der Sprache, in der geprüft wird.
- [ ] Ein Eintrag lässt sich mit seinem eigenen, unveränderten Kurznamen erneut veröffentlichen.
- [ ] `yarn format`, `yarn check-types` und `yarn test` sind grün.

## Blockiert von
keine — kann sofort starten

<details><summary>Roter Diagnosetest <code>apps/cms/src/collections/Pages/pages.slug-uniqueness.int.test.ts</code></summary>

```ts
import config from "@/payload.config";
import { getPayload, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// HOF-356: two pages under the same parent must not share a slug in the
// same language, otherwise both resolve to the same address and only one is
// reachable. Runs against the real CMS config and the test MongoDB
// (DATABASE_URI from vitest.config.ts, started in CI via `yarn dc:up`).
let payload: Payload;

beforeAll(async () => {
  payload = await getPayload({ config });
  await payload.db.collections.pages.deleteMany({});
}, 120000);

afterAll(async () => {
  await payload?.db?.collections?.pages?.deleteMany({});
  await payload?.db?.destroy?.();
});

const publish = async (
  de: string,
  en: string,
  parent?: string,
  enSlug?: string,
) => {
  const doc = await payload.create({
    collection: "pages",
    locale: "de",
    data: { title: de, _status: "published", ...(parent && { parent }) },
  });
  return payload.update({
    collection: "pages",
    id: doc.id,
    locale: "en",
    data: { title: en, _status: "published", ...(enSlug && { slug: enSlug }) },
  });
};

// Payload's ValidationError lists the failing field paths in data.errors.
const slugTaken = {
  data: { errors: [expect.objectContaining({ path: "slug" })] },
};

describe("Pages slug uniqueness per parent and language (HOF-356)", () => {
  it("rejects publishing a second English page with the same slug under the same parent", async () => {
    const parent = await publish(
      "Funktionen und Module",
      "Functions and Modules",
    );
    await publish("Gemüsekisten", "Vegetable Boxes", String(parent.id));

    await expect(
      publish(
        "Obstkisten (Bio)",
        "Fruit Boxes (Organic)",
        String(parent.id),
        "vegetable-boxes",
      ),
    ).rejects.toMatchObject(slugTaken);
  });

  it("rejects two English pages whose titles produce the same slug under the same parent", async () => {
    const parent = await publish("Termine", "Events");
    await publish("Hoffest 2026", "Hoffest", String(parent.id));

    await expect(
      publish("Hoffest 2027", "Hoffest", String(parent.id)),
    ).rejects.toMatchObject(slugTaken);
  });

  it("saves a draft with a taken slug but rejects publishing it", async () => {
    const parent = await publish("Lösungen", "Solutions");
    await publish("Molkerei", "Dairy", String(parent.id));
    const page = await publish("Hofkäse", "Farm Cheese", String(parent.id));

    await expect(
      payload.update({
        collection: "pages",
        id: page.id,
        locale: "en",
        draft: true,
        data: { slug: "dairy", _status: "draft" },
      }),
    ).resolves.toMatchObject({ slug: "dairy" });
    await expect(
      payload.update({
        collection: "pages",
        id: page.id,
        locale: "en",
        data: { slug: "dairy", _status: "published" },
      }),
    ).rejects.toMatchObject(slugTaken);
  });

  it("allows the same slug under different parents", async () => {
    const a = await publish("Bereich A", "Area A");
    const b = await publish("Bereich B", "Area B");
    await publish("Übersicht", "Overview", String(a.id));

    await expect(
      publish("Übersicht", "Overview", String(b.id)),
    ).resolves.toMatchObject({ slug: "overview" });
  });

  it("allows a slug that a sibling only uses in the other language", async () => {
    const parent = await publish("Produkt", "Product");
    // German slug "hofbrot", English slug "farm-bakery"
    await publish("Hofbrot", "Farm Bakery", String(parent.id));

    // German slug "farm-bakery" only collides with the sibling's English slug
    const page = await publish(
      "Farm Bakery",
      "Farm Bread",
      String(parent.id),
    );
    const german = await payload.findByID({
      collection: "pages",
      id: page.id,
      locale: "de",
    });
    expect(german.slug).toBe("farm-bakery");
  });

  it("lets a page be saved again with its own slug", async () => {
    const parent = await publish("Unternehmen", "Company");
    const page = await publish("Team", "Team", String(parent.id));

    await expect(
      payload.update({
        collection: "pages",
        id: page.id,
        locale: "en",
        data: { title: "Our Team", _status: "published" },
      }),
    ).resolves.toMatchObject({ slug: "team" });
  });
});
```

</details>

