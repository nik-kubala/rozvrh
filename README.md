# Rozvrh

Interaktívny prehliadač termínov a šablón rozvrhu pre VŠB-TUO, zimný semester 2026/27.

## Čo stránka vie

- zobraziť všetky dostupné termíny konkrétneho predmetu,
- farebne oddeliť prednášky (P) a cvičenia (C),
- filtrovať iba P alebo iba C,
- zobraziť detail vybraného termínu,
- prepínať medzi pripravenými šablónami rozvrhu,
- automaticky ukázať počet školských dní, najskorší začiatok, najneskorší koniec, voľný štvrtok/piatok a kolízie,
- mobilné zobrazenie ako agenda bez nutnosti posúvať veľkú tabuľku.

## Dáta

Všetky termíny sú v `data.js`. Keď pribudne nový termín alebo nová šablóna, netreba meniť UI.

Šablóna obsahuje iba pole `sessionIds`, napr.:

```js
{
  id: "moja-sablona",
  name: "Moja šablóna",
  description: "Krátky popis",
  sessionIds: [
    "logic-p01",
    "digital-p02",
    "english-c15"
  ],
  warnings: []
}
```

## Dôležité

- Dáta boli prepísané zo screenshotov VŠB-TUO z 7. 9. 2026.
- Pri `Základy informačních technologií` je na dodanom screenshote iba C/01–C/04. Termín prednášky zatiaľ chýba, preto ho UI aj existujúce šablóny označujú ako neúplný.
- Časové bloky sú nastavené tak, aby medzi susednými blokmi zostal 15-minútový presun.

## Spustenie

Stránka je čisté HTML/CSS/JS bez build procesu.

Lokálne stačí otvoriť `index.html`. Pre GitHub Pages nastav repozitár tak, aby publikoval koreň vetvy `main`.
