# EDISON Rozvrh Assistant

Bezpečný Tampermonkey userscript pre adaptívny zápis rozvrhu vo VŠB-TUO EDISONe. Userscript používa rovnaké `optimizer-core.js` ako GitHub Pages a pri každom kroku chráni nielen aktuálne najlepší rozvrh, ale aj budúcu množinu kvalitných fallbackov.

## Bezpečnostné hranice

- Script sa spúšťa iba na `https://edison.sso.vsb.cz/wps/*`.
- Používa iba relatívne same-origin endpointy a `credentials: "same-origin"`.
- Cookies, `LtpaToken`, `JSESSIONID`, heslá ani iné session údaje nečíta, neloguje, neexportuje a neposiela na GitHub.
- Po reloade je AUTO vždy `OFF`. Stav `ARMED` ani `RUNNING` sa nikdy neukladá.
- Reálny zápis vyžaduje dve samostatné kliknutia: `ARM`, potom do 60 sekúnd `START`.
- `STOP` abortne rozpracované fetch požiadavky a zakáže všetky ďalšie kroky. Už spracovaný serverový request nie je možné spätne odvolať abortom.
- `UNDO / RESET LOCAL STATE` nikdy nevolá deselect endpoint a nemení serverový rozvrh.
- Concurrency limit je 2. Script nemá nekonečný polling ani nekonečné retry.
- Pri network chybe sa použije najviac jeden kontrolovaný retry po 750 ms, potom STOP.
- `REGISTRATION_CLOSED`, `AUTH_EXPIRED`, neznáma odpoveď alebo stav bez prijateľného layoutu okamžite zastavia AUTO.
- TVA a Bezpečnost v elektrotechnice sú zámerne mimo optimalizéra.

## Inštalácia

1. Otvor `edison-rozvrh-assistant.user.js` v tomto repozitári.
2. V Tampermonkey vytvor nový script, nahraď jeho obsah celým súborom a ulož ho.
3. Otvor EDISON → Rozvrh → Volba rozvrhu.
4. Vpravo dole sa zobrazí panel `EDISON Rozvrh Assistant`.

Script je self-contained. Na EDISONe nenačítava JS z GitHub Pages ani inú externú závislosť. Generuje sa zo spoločných zdrojov:

```bash
npm run build:userscript
```

Ručne neupravuj generovaný `edison-rozvrh-assistant.user.js`; zmeny urob v `optimizer-core.js`, dátach alebo `scripts/userscript-runtime.js` a znova spusti build.

## Ako to spustiť v deň zápisu

1. Prihlás sa do EDISONu s predstihom a otvor stránku `Volba rozvrhu`.
2. Over, že panel hlási `načítané predmety: 7/7`.
3. Klikni `REFRESH DATA` a skontroluj aktuálne kapacity, robust target a nasledujúci krok.
4. Klikni `DRY RUN`. Tento režim načíta dáta a ukáže bezpečný prvý batch aj vetvy SUCCESS/FAIL, ale nikdy nevolá `selectConcreteActivity`.
5. Keď panel hlási `registrácia: open`, klikni `ARM`.
6. Skontroluj odporúčaný krok a do 60 sekúnd klikni `START`.
7. Maj kurzor pri `STOP`. Pri chybe script zastaví AUTO aj sám.
8. Po dokončení skontroluj serverový rozvrh priamo v EDISONe. TVA vyber neskôr manuálne.

Ak sa stránka reloadne, treba znova kliknúť `ARM` a `START`.

## Ovládanie panelu

- `REFRESH DATA` — zavolá jeden `refreshPage` request a read/load request pre každý zo 7 predmetov, najviac dva súčasne.
- `DRY RUN` — prepočíta poradie a vetvy bez jediného zápisového requestu.
- `COPY LIVE JSON` — skopíruje iba necitlivé activity ID, kódy, časy, kapacity a stavy. Neobsahuje cookies, tokeny ani identitu. Tento JSON možno vložiť do GitHub Pages cez `Vložiť LIVE JSON`.
- `ARM` — povolí START na 60 sekúnd, iba ak je 7/7 predmetov načítaných a server hlási otvorenú registráciu.
- `START` — začne adaptívny zápis.
- `STOP` — okamžite zastaví ďalšie kroky.
- `UNDO / RESET LOCAL STATE` — vymaže lokálne failure/locked rozhodnutia a znovu načíta serverový stav; nič neodhlasuje zo servera.

## Zistenia z EDISONu (read-only kontrola 8. 9. 2026, 00:48 CEST)

EDISON na stránke uvádzal registračné okno od `8. 9. 2026 10:00` do `27. 9. 2026 23:59`, takže počas kontroly ešte nebolo otvorené. Nebol vykonaný žiadny pokus o zápis.

Tabuľka `subjectsTable` obsahuje pri každom predmete:

- skratku predmetu,
- číslo predmetu v `abbr[title]`, napr. `460-2079/01`,
- `onclick="...selectStudyYearObligation(7860488)"`, z ktorého sa dá dynamicky získať `studyYearObligationId`,
- ikony `subjectUsageImg:{studyYearObligationId}:0|1`, ktoré zobrazujú zvolenú P/C časť.

Aktuálne mappingy nájdené v DOM sú iba diagnostický snapshot; script ich nemá hardcoded:

| Predmet | subjectVersionScheduleCode | studyYearObligationId |
|---|---:|---:|
| ZDS | 440210401 | 7860483 |
| ULM | 460205103 | 7860492 |
| UPR | 460205205 | 7860487 |
| ZIT | 460207901 | 7860488 |
| LA | 470220501 | 7860490 |
| PvICT | 711043901 | 7860499 |
| A/I-FEI | 712012401 | 7860493 |

Klientsky kód EDISONu vykresľuje activity ako vybrané pri `selected === true`. Ak activity nie je vybraná, zobrazí odkaz na voľbu iba pri `hasFreePlaces === true`. Pri zvolenej activity vykreslí odkaz na zrušenie voľby. Response po select/unselect klient používa na prekreslenie `subjectScheduleTable`, `scheduleTable` a `subjectUsages`; `errMsg` zobrazuje ako serverovú chybu.

Overený deselect endpoint existuje, ale Assistant ho zámerne nepoužíva.

## Endpointy

Všetky requesty sú relatívne k prihlásenému originu EDISONu.

### Stav stránky a registračného okna

```http
GET /wps/.cz.vsb.edison.edu.study.pass.portlet/jaxrs/scheduleSelection/refreshPage?portletId={portletId}
```

Response má pole `opened`. Klient EDISONu pri `opened === true` prekreslí `scheduleTable` a `subjectUsages`.

### Read/load konkrétneho predmetu

```http
PUT /wps/.cz.vsb.edison.edu.study.pass.portlet/jaxrs/scheduleSelection/selectStudyYearObligation/{studyYearObligationId}
Content-Type: application/x-www-form-urlencoded

portletId={portletId}
```

Tento request nemení zápis; načíta `subjectScheduleTable`. Assistant ho používa pri REFRESH/DRY RUN, s limitom 2 súbežné požiadavky.

### Zápis activity

```http
PUT /wps/.cz.vsb.edison.edu.study.pass.portlet/jaxrs/scheduleSelection/selectConcreteActivity/{concreteActivityId}
Content-Type: application/x-www-form-urlencoded

portletId={portletId}
```

### Zrušenie activity (nepoužíva sa)

```http
PUT /wps/.cz.vsb.edison.edu.study.pass.portlet/jaxrs/scheduleSelection/unselectConcreteActivity/{concreteActivityId}
```

## Dynamické mapovanie

1. Script nájde riadok predmetu podľa čísla predmetu v DOM.
2. Z čísla odstráni pomlčku a lomku, čím získa rovnaký kód ako `subjectVersionScheduleCode`.
3. Z `onclick` vyberie aktuálny `studyYearObligationId`.
4. Read/load response rekurzívne prejde a vyberie DTO s `concreteActivityId`.
5. DTO mapuje na lokálny termín kombináciou `subjectVersionScheduleCode + C/P skupina + deň + začiatok`.

Activity ID ani obligation ID nie sú súčasťou optimalizačnej databázy a môžu sa zmeniť medzi semestrami.

## Detekcia výsledku

Samotné HTTP 200 nikdy nie je úspech.

- `SUCCESS` — response nemá `errMsg` a DTO presne požadovaného `concreteActivityId` má `selected === true`.
- `FULL` — požadované DTO má `hasFreePlaces === false` alebo serverová správa jednoznačne hovorí o kapacite/obsadení.
- `COLLISION` — serverová správa alebo DTO hlási kolíziu.
- `REGISTRATION_CLOSED` — serverová správa hovorí, že voľba nie je otvorená; nasleduje STOP bez retry.
- `AUTH_EXPIRED` — HTTP 401/403, redirect alebo HTML namiesto JSON; nasleduje STOP.
- `NETWORK_ERROR` — najviac jeden retry, potom STOP.
- `UNKNOWN_SERVER_ERROR` — odpoveď nepotvrdí požadované activity ID; nasleduje STOP.

Po každom výsledku sa okamžite aktualizujú locked/unavailable activity a optimizer prepočíta celý ďalší strom.

## Combined risk score

Poradie kombinuje:

- `subjectImportance`,
- `fallbackLoss` — strata quality mass po failure,
- `scheduleRegret` — zhoršenie najlepšieho zostávajúceho layoutu,
- počet rôznych časových alternatív,
- počet rovnakých skupín v identickom čase,
- `capacityPressure`.

Kapacitný tlak je normalizovaný do 0–1:

```text
0.55 × obsadenosť
+ 0.30 × exp(-voľné_miesta / 8)
+ 0.15 × exp(-kapacita / 25)
```

Vďaka tomu je 23/25 výrazne urgentnejšie než 0/94, ale kapacita neprekryje rozvrhovú kritickosť. Strata všetkých prijateľných fallbackov dostane extra kritickú penalizáciu.

Quality mass zvýhodňuje rozvrhy s lepším priemerným hodnotením a nižším časovým costom. Robust target minimalizuje kombináciu vlastného costu a slabej podpory svojich jednotlivých blokov v celej zostávajúcej množine plánov.

## Bezpečná paralelizácia

1. Optimizer zostaví zoradených kandidátov.
2. Pred batchom simuluje všetky kombinácie SUCCESS/FAILURE.
3. Dve activity môžu ísť súčasne iba ak sa nekolidujú a každá vetva zachová aspoň jeden prijateľný layout aj minimálnu quality mass.
4. Ak podmienka neplatí, pošle sa iba najkritickejší request a čaká sa na response.
5. Limit je 2; prednášky idú po jednej.

Cvičenia sa riešia prvé. Potom nasledujú:

- ULM P/01 — Po 07:15,
- LA P/01 — Po 12:30,
- UPR P/01 aj P/02 — Ut 09:00, striedavé týždne,
- ZDS P/02 — Po 10:45; iba pri nedostupnosti fallback P/01 — Št 07:15.

## GitHub Pages LIVE

GitHub Pages nemôže bezpečne volať EDISON kvôli CORS a same-origin session. LIVE karta preto zostáva viewer/tester:

1. V EDISON Assistante klikni `COPY LIVE JSON`.
2. Na GitHub Pages v `Zápis LIVE` klikni `Vložiť LIVE JSON`.
3. Viewer prepočíta kapacity, risk, poradie, quality mass, best rating, robust target a DRY RUN rovnakým jadrom.

## Testy

```bash
npm test
```

Testy pokrývajú všetky požadované scenáre A–G, dynamické mapovanie, success/failure klasifikáciu, safe batch, kolízie, jeden C termín na predmet, povinné prednášky, 15-minútový buffer, zákaz ratingu 5/5 a dokončenie bez zaseknutia.

## Čo pred otvorením registrácie nebolo bezpečne overené

- Presný JSON úspešného zápisu nebol vyvolaný, pretože by to bol skutočný zápis. Detekcia sa opiera o presné `selected === true` pre požadované activity ID a o klientsky kód EDISONu.
- Nebol vykonaný ani „očakávane neúspešný“ select request; read-only prieskum poskytol dostatok informácií a nebolo potrebné riskovať zápisovú akciu.
- Reálna odozva servera pri špičke a jeho rate limit nie sú známe.
- `hasCollision` sa môže objaviť v response DTO alebo v `errMsg`; aktuálny zatvorený stav neumožnil získať reálny collision response.

## Odhad rýchlosti

Pri všetkých úspechoch je potrebných 7 cvičebných a 5 prednáškových selectov. Cvičenia môžu ísť v bezpečných dvojiciach, prednášky po jednej. Podľa read-only odozvy pozorovanej mimo špičky je realistický technický čas približne **4–8 sekúnd**, konzervatívne **8–15 sekúnd** pri vyššej latencii. Failure vetvy alebo preťažený EDISON čas predĺžia; bezpečnosť a okamžité prepočítanie fallbackov majú prednosť pred slepým odoslaním všetkého naraz.
