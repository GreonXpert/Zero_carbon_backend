'use strict';

const router = require('express').Router();
const c = require('../controllers/allocationsController');

// Nested under targets
router.post  ('/targets/:targetId/allocations/bulk',   c.bulkUpsertAllocations);
router.post  ('/targets/:targetId/allocations',        c.createAllocation);
router.get   ('/targets/:targetId/allocations',        c.listAllocations);

// Standalone allocation operations
router.get   ('/allocations/:allocationId',            c.getAllocation);
router.patch ('/allocations/:allocationId',            c.updateAllocation);
router.delete('/allocations/:allocationId',            c.deleteAllocation);
router.post  ('/allocations/:allocationId/submit',     c.submitAllocation);
router.post  ('/allocations/:allocationId/approve',    c.approveAllocation);

module.exports = router;
