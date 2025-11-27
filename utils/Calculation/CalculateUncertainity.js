exports.calculateUncertainty = function (baseValue, UAD, UEF) {
  // Convert UAD to signed decimal
  let uad = Number(UAD);
  if (Math.abs(uad) > 1) uad = uad / 100;   // convert 10 → 0.10, -10 → -0.10

  // Convert UEF to signed decimal
  let uef = Number(UEF);
  if (Math.abs(uef) > 1) uef = uef / 100;

  // Combined uncertainty (always positive magnitude)
  const combinedMagnitude = Math.sqrt(Math.pow(uad, 2) + Math.pow(uef, 2));  

  // Determine FINAL SIGN:
  // If total raw uncertainty is negative → subtract
  // If positive → add
  const rawSum = uad + uef;
  const sign = rawSum < 0 ? -1 : 1;

  // Apply sign to magnitude
  const combinedSigned = combinedMagnitude * sign;

  // Final emission with uncertainty
  return baseValue * (1 + combinedSigned);
}
