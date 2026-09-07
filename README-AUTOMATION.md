# EDISON Rozvrh Assistant

Tampermonkey userscript pre adaptívny zápis rozvrhu vo VŠB-TUO EDISONe. Používa rovnaké `optimizer-core.js`, `fixed-plans.js` a `preferences.js` ako GitHub Pages LIVE, takže rozhoduje nad tou istou sadou 100 hodnotených rozvrhov a rovnakými spriemerovanými hodnoteniami.

## Čo sa zmenilo pred ostrým zápisom

- odstránený `ARM` krok; panel má jedno hlavné tlačidlo `ŠTART ZÁPIS`, ktoré sa počas behu zmení na `STOP`,
- odstránená závislosť od `refreshPage`, ktorá na niektorých EDISON session vracala falošné `AUTH_EXPIRED`,
- read-only dáta sa načítavajú priamo cez overený `selectStudyYearObligation/{id}` endpoint,
- response sa skúša parsovať ako JSON bez ohľadu na `Content-Type` alebo interný redirect; `AUTH_EXPIRED` sa hlási až pri skutočnom 401/403 alebo HTML/login odpovedi,
- pridaný header `X-Requested-With: XMLHttpRequest`, rovnako ako v reálnom EDISON requeste,
- každý plný refresh vytvorí nový LIVE snapshot od nuly, takže sa nezachovajú staré activity ID ani staré kapacity,
- serverový `selected === true` stav je autoritatívny; lokálne locky sa pri plnom načítaní kompletne zrekonštruujú zo servera,
- `hasCollision === true` a `hasFreePlaces === false` sa pred ďalším krokom automaticky považujú za nedostupné,
- lokálny stav sa už nepersistuje cez reload; po reloade sa znova zostaví zo servera,
- cvičenia sa zobrazujú ako `0/7 … 7/7 PASSED`; potom automat pokračuje prednáškami,
- pred 10:00 sa dá kliknúť `ŠTART ZÁPIS` vopred; script počká na `08.09.2026 10:00:00 CEST` a spustí prvý zápis bez ďalšieho kliku,
- približne o `09:59:50` sa automaticky spraví posledný read-only preflight, ak je stránka otvorená,
- ak EDISON tesne na hranici 10:00 ešte vráti `REGISTRATION_CLOSED`, script urobí najviac 6 krátkych kontrolovaných retry po 350 ms; mimo tejto hranice nespamuje.

## Inštalácia

1. Otvor `edison-rozvrh-assistant.user.js`.
2. V Tampermonkey vytvor nový userscript, vlož celý súbor a ulož ho.
3. Otvor EDISON → Rozvrh → Volba rozvrhu.
4. Vpravo dole sa musí zobraziť `EDISON Rozvrh Assistant`.
5. Pred ostrým použitím skontroluj, že panel ukazuje `LIVE dáta 7/7`.

Script je self-contained. Cookies, `LtpaToken`, `JSESSIONID`, heslá ani session tokeny neukladá ani neposiela mimo `edison.sso.vsb.cz`.

## Presný postup 8. 9. 2026

Najbezpečnejší a zároveň najrýchlejší postup:

1. Najneskôr pár minút pred 10:00 sa prihlás do EDISONu a otvor `Volba rozvrhu`.
2. Over `LIVE dáta 7/7`.
3. Ideálne medzi `09:59:50` a `09:59:59` klikni raz `ŠTART ZÁPIS`.
4. Panel zobrazí, že čaká na 10:00. Už nič ďalšie netreba klikať.
5. O 10:00 začne adaptívny zápis.
6. Po úspešnom zapísaní siedmich cvičení sa zobrazí `7/7 PASSED ✓` a script automaticky dokončí povinné prednášky.
7. Finálny stav je `HOTOVO — cvičenia 7/7 PASSED, prednášky 5/5 PASSED`.
8. TVA sa zámerne nezapisuje; šport sa vyberá manuálne neskôr.

Počas behu sa jediné hlavné tlačidlo zmení na `STOP`, takže v prípade potreby vieš ďalšie requesty okamžite zastaviť.

## Rovnaká rozvrhová logika ako GitHub Pages

Áno. GitHub Pages `registration.js` aj EDISON userscript vytvárajú optimizer cez rovnaké:

```js
core.createOptimizer({
  data: window.ROZVRH_DATA,
  fixedPlans: window.ROZVRH_FIXED_PLANS,
  preferences: window.ROZVRH_PREFERENCES
})
```

To znamená, že userscript používa:

- rovnakých 100 fixných layoutov,
- rovnaké dve spriemerované hodnotenia 1–5,
- hard reject layoutov s konsenzom 5/5,
- rovnaké časové preferencie,
- rovnaké silné preferovanie Po–St,
- rovnakú penalizáciu štvrtka a piatka,
- rovnakú `quality mass`, `fallback loss`, `schedule regret` a `robust target` logiku,
- rovnaké predmetové priority,
- navyše LIVE kapacity z EDISONu.

Po každom SUCCESS/FULL/COLLISION výsledku sa celý optimizer spustí znova a ďalší request sa vyberie z aktuálne zostávajúcich kvalitných rozvrhov. Script teda nejde slepo podľa jedného pevného plánu.

## Predmety

Cvičenia sa riešia ako prvé pre:

- ZDS,
- ULM,
- UPR,
- ZIT,
- LA,
- PvICT,
- A/I-FEI.

Potom prednášky:

- ULM P/01 — Po 07:15,
- LA P/01 — Po 12:30,
- UPR P/01 — Ut 09:00, sudý týždeň,
- UPR P/02 — Ut 09:00, lichý týždeň,
- ZDS preferovane P/02 — Po 10:45; fallback P/01 — Št 07:15.

ZIT, Angličtina a Právo nemajú v tomto optimizéri prednášku. TVA a Bezpečnost v elektrotechnice sú mimo automatu.

## EDISON endpointy

### Read-only načítanie predmetu

```http
PUT /wps/.cz.vsb.edison.edu.study.pass.portlet/jaxrs/scheduleSelection/selectStudyYearObligation/{studyYearObligationId}
Content-Type: application/x-www-form-urlencoded
X-Requested-With: XMLHttpRequest

portletId={aktuálny portletId z DOM}
```

`studyYearObligationId` sa zisťuje dynamicky z riadku predmetu v `subjectsTable`. Nie je hardcoded.

### Zápis konkrétnej activity

```http
PUT /wps/.cz.vsb.edison.edu.study.pass.portlet/jaxrs/scheduleSelection/selectConcreteActivity/{concreteActivityId}
Content-Type: application/x-www-form-urlencoded
X-Requested-With: XMLHttpRequest

portletId={aktuálny portletId z DOM}
```

Activity ID sa vždy získava z aktuálneho EDISON response.

## Detekcia výsledku

HTTP 200 sám osebe nie je úspech.

- `SUCCESS` — bez relevantného `errMsg` a požadované `concreteActivityId` má `selected === true`,
- `FULL` — activity nemá voľné miesto alebo server hlási kapacitu/obsadenie,
- `COLLISION` — DTO alebo serverová správa hlási kolíziu,
- `REGISTRATION_CLOSED` — voľba ešte nie je otvorená,
- `AUTH_EXPIRED` — 401/403 alebo HTML/login odpoveď,
- `NETWORK_ERROR` — jeden kontrolovaný retry, potom STOP,
- `UNKNOWN_SERVER_ERROR` — response nepotvrdí očakávaný stav; STOP namiesto riskantného pokračovania.

## Bezpečná paralelizácia

Concurrency limit je 2. Pred odoslaním druhého cvičenia v paralelnom batchi optimizer simuluje kombinácie SUCCESS/FAILURE. Dvojica sa odošle iba vtedy, keď výsledkové vetvy zachovávajú prijateľný fallback. Prednášky idú po jednej.

## CI a testy

Repo obsahuje workflow `.github/workflows/userscript-ci.yml`. Pri každej relevantnej zmene:

1. spustí `npm test`,
2. spustí `npm run build:userscript`,
3. ak sa bundle zmenil, commitne nový `edison-rozvrh-assistant.user.js`.

Optimizer testy pokrývajú základný stav, plný ZIT, plný preferovaný UPR/ZDS fallback, viac nedostupných termínov, štvrtkové fallbacky, nulový validný layout, 15-min buffer, obidve UPR prednášky, capacity pressure a success/failure klasifikáciu.

## Čo sa nedá garantovať pred 10:00

Kód a build vieme otestovať, ale skutočný úspešný `selectConcreteActivity` response sa nedá bezpečne vyvolať pred otvorením registrácie bez reálneho zápisu. Preto nemožno technicky sľúbiť 100 % dostupnosť cudzieho EDISON servera alebo jeho správanie pri špičke.

Script je navrhnutý tak, aby pri neznámej odpovedi radšej zastavil, než posielal nekontrolované alebo duplicitné requesty.
