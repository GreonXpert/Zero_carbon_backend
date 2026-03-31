function round6(v) {
  return Number((Number(v) || 0).toFixed(6));
}

function calculateEmployeeCommutingUncertainty({
  totalEmployeeCommutingKgCO2e = 0,
  submittedCount = 0,
  totalLinks = 0,
  UAD = 0,
  UEF = 0,
  conservativeMode = false,
}) {
  const base = Number(totalEmployeeCommutingKgCO2e) || 0;
  const uad = Number.isFinite(Number(UAD)) ? Number(UAD) : 0;
  const uef = Number.isFinite(Number(UEF)) ? Number(UEF) : 0;
  const total = Number(totalLinks) || 0;
  const submitted = Number(submittedCount) || 0;

  const submissionPct = total > 0 ? (submitted / total) * 100 : 0;
  const remainingPct = Math.max(0, 100 - submissionPct);

  const uncertaintyPercent = Math.sqrt((uad ** 2) + (uef ** 2));
  const deltaSurvey = base * (uncertaintyPercent / 100);
  const deltaCompletionGap = base * (remainingPct / 100);
  const totalUncertainty = deltaSurvey + deltaCompletionGap;

  const totalEmployeeCommutingWithUncertainityExactKgCO2e = conservativeMode
    ? base + deltaSurvey
    : base;

  return {
    base: round6(base),
    UAD: round6(uad),
    UEF: round6(uef),
    uncertaintyPercent: round6(uncertaintyPercent),
    deltaSurvey: round6(deltaSurvey),
    deltaCompletionGap: round6(deltaCompletionGap),
    totalUncertainty: round6(totalUncertainty),
    submissionPct: round6(submissionPct),
    remainingPct: round6(remainingPct),
    totalEmployeeCommutingWithUncertainityExactKgCO2e: round6(
      totalEmployeeCommutingWithUncertainityExactKgCO2e
    ),
    range: {
      low: round6(base - deltaSurvey),
      high: round6(base + deltaSurvey),
    },
    conservativeMode,
  };
}

module.exports = { calculateEmployeeCommutingUncertainty };