'use strict';

const router = require('express').Router();
const c = require('../controllers/evidenceController');

router.post('/evidence',                               c.uploadAttachment);
router.get ('/:entityType/:entityId/attachments',      c.listAttachments);

module.exports = router;
