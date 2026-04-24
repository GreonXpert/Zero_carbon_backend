function normalizeAllocationPayload(data) {
  const scopeDetailAllocationPct =
    data.scopeDetailAllocationPct ??
    data.allocated_pct ??
    100;

  return {
    ...data,
    allocated_pct: Number(data.allocated_pct ?? scopeDetailAllocationPct),
    scopeAllocationPct: Number(data.scopeAllocationPct ?? 100),
    categoryAllocationPct: Number(data.categoryAllocationPct ?? 100),
    nodeAllocationPct: Number(data.nodeAllocationPct ?? 100),
    scopeDetailAllocationPct: Number(scopeDetailAllocationPct),
    absoluteAllocatedValue: Number(data.absoluteAllocatedValue ?? 0),
    source_code: data.source_code || data.scopeIdentifier || data.nodeId,
    category_code: data.category_code || data.categoryName || 'UNCATEGORIZED',
    facility_id: data.facility_id || data.nodeId,
  };
}

module.exports = { normalizeAllocationPayload };