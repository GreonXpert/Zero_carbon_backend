'use strict';

const express = require('express');
const router  = express.Router();

const templateRoutes = require('./templateRoutes');
const reportRoutes   = require('./reportRoutes');
const exportRoutes   = require('./exportRoutes');
const auditRoutes    = require('./auditRoutes');

router.use('/templates', templateRoutes);
router.use('/reports',   reportRoutes);
router.use('/reports',   exportRoutes);   // export routes share /reports/:id prefix
router.use('/audit',     auditRoutes);

module.exports = router;
