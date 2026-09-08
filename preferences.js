window.ROZVRH_PREFERENCES = {
  version: 4,
  source: "average-of-two-complete-1-to-5-exports",
  consensusRatings: {"A001":1.0,"A002":1.0,"A003":1.0,"A004":2.0,"A005":2.0,"A006":1.0,"A007":1.0,"A008":1.5,"A009":2.5,"A010":1.5,"A011":1.0,"A012":2.5,"A013":1.5,"A014":2.5,"A015":2.0,"A016":1.0,"A017":3.5,"A018":5.0,"A019":3.5,"A020":3.5,"A021":1.0,"A022":1.0,"A023":1.0,"A024":2.0,"A025":2.0,"A026":1.0,"A027":2.0,"A028":3.0,"A029":3.0,"A030":1.0,"A031":2.0,"A032":3.0,"A033":5.0,"A034":4.0,"A035":1.0,"A036":3.0,"A037":1.0,"A038":2.5,"A039":2.0,"A040":3.5,"A041":2.0,"A042":3.0,"A043":1.0,"A044":1.0,"A045":3.0,"A046":2.5,"A047":3.0,"A048":3.0,"A049":2.0,"A050":3.5,"A051":2.0,"A052":1.0,"A053":1.5,"A054":3.0,"A055":1.5,"A056":3.0,"A057":3.0,"A058":2.0,"A059":5.0,"A060":3.5,"B001":4.0,"B002":4.0,"B003":4.0,"B004":4.0,"B005":4.5,"B006":5.0,"B007":5.0,"B008":5.0,"B009":5.0,"B010":4.0,"B011":5.0,"B012":5.0,"B013":4.0,"B014":5.0,"B015":4.5,"B016":4.0,"B017":5.0,"B018":5.0,"B019":4.0,"B020":4.0,"B021":5.0,"B022":5.0,"B023":4.0,"B024":4.0,"B025":4.0,"B026":4.0,"B027":4.0,"B028":5.0,"B029":5.0,"B030":5.0,"C001":5.0,"C002":5.0,"C003":5.0,"C004":5.0,"C005":5.0,"C006":5.0,"C007":5.0,"C008":5.0,"C009":5.0,"C010":5.0},
  hardRejectAt: 5,
  subjectImportance: {
    it: 100,
    algebra: 90,
    programming: 80,
    digital: 70,
    law: 55,
    logic: 30,
    english: 20
  },
  teacherPreferences: {
    preferred: ["M. Menšík", "A. Albert", "P. Illík", "J. Klega"],
    lastChoice: ["M. Běhálek"]
  },
  lectureRequirements: [
    { key: "lecture:logic", subjectId: "logic", alternatives: ["logic-p01"] },
    { key: "lecture:algebra", subjectId: "algebra", alternatives: ["algebra-p01"] },
    { key: "lecture:programming", subjectId: "programming", alternatives: ["programming-p01", "programming-p02"] },
    { key: "lecture:digital", subjectId: "digital", alternatives: ["digital-p02", "digital-p01"] }
  ],
  slotPenalty: [8, 0, 2, 7, 18, 32, 48],
  thursdaySlotPenalty: [0, 8, 18, 35, 60, 95, 140],
  rules: {
    ratingWeight: 600,
    thursdayBasePenalty: 320,
    fridayBasePenalty: 2200,
    extraSchoolDayPenalty: 160,
    gapPenalty: 12,
    robustnessAveragePenalty: 260,
    robustnessWeakLinkPenalty: 520,
    concurrencyLimit: 2,
    batchMinimumMassRatio: 0.02
  }
};
