(() => {
  const data = window.ROZVRH_DATA;
  if (!data) return;

  // Rozsah výuky podľa zápisu predmetov VŠB-TUO:
  // prvé číslo = prednáška, druhé číslo = cvičenie.
  // ZIT má 0+2, teda iba cvičenie a žiadnu prednášku.
  const zit = data.subjects.find((subject) => subject.id === "it");
  if (zit) {
    zit.requirement = "C";
    delete zit.missingLecture;
  }

  // Staršie šablóny obsahovali upozornenie na údajne chýbajúcu prednášku ZIT.
  // Po oprave 0+2 toto upozornenie už neplatí.
  for (const template of data.templates || []) {
    if (!Array.isArray(template.warnings)) continue;
    template.warnings = template.warnings.filter(
      (warning) => !warning.includes("prednášky zo Základov informačních technologií")
    );
  }
})();
