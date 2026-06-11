'use strict';

const { templateService }        = require('../services/templateService');
const { ragAuditService }        = require('../services/ragAuditService');
const { validateTemplateSchema } = require('../utils/templateSchemaValidator');

const templateController = {
  async list(req, res, next) {
    try {
      const { type, status, platform, page, limit } = req.query;
      const result = await templateService.list({
        type, status, platform,
        page:  parseInt(page  || '1',  10),
        limit: parseInt(limit || '20', 10)
      });
      res.json(result);
    } catch (err) { next(err); }
  },

  async create(req, res, next) {
    try {
      const { name, description, type, platform, tags, structure } = req.body;

      const validation = validateTemplateSchema(structure);
      if (!validation.valid) {
        return res.status(422).json({ error: 'INVALID_TEMPLATE_SCHEMA', details: validation.errors });
      }

      const { template, version } = await templateService.createWithVersion({
        name, description, type, platform, tags, structure,
        createdBy: req.user.id
      });

      ragAuditService.log({
        action:   'TEMPLATE_CREATED',
        actor:    req.user,
        resource: { type: 'template', id: template._id },
        after:    { name, type, status: 'draft', version: 1 },
        context:  { req }
      });

      res.status(201).json({ template, version });
    } catch (err) { next(err); }
  },

  async getById(req, res, next) {
    try {
      const template = await templateService.getById(req.params.id);
      if (!template) return res.status(404).json({ error: 'NOT_FOUND' });
      res.json({ template });
    } catch (err) { next(err); }
  },

  async update(req, res, next) {
    try {
      const { structure, changelog } = req.body;

      const validation = validateTemplateSchema(structure);
      if (!validation.valid) {
        return res.status(422).json({ error: 'INVALID_TEMPLATE_SCHEMA', details: validation.errors });
      }

      const existing = await templateService.getById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

      const { template, version } = await templateService.createNewVersion({
        templateId: req.params.id,
        structure,
        changelog,
        createdBy:  req.user.id
      });

      ragAuditService.log({
        action:   'TEMPLATE_VERSION_CREATED',
        actor:    req.user,
        resource: { type: 'templateVersion', id: version._id },
        before:   { version: existing.currentVersion },
        after:    { version: version.version, changelog },
        context:  { req }
      });

      res.json({ template, version });
    } catch (err) { next(err); }
  },

  async archive(req, res, next) {
    try {
      const existing = await templateService.getById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

      const template = await templateService.archive(req.params.id, req.user.id);

      ragAuditService.log({
        action:   'TEMPLATE_ARCHIVED',
        actor:    req.user,
        resource: { type: 'template', id: template._id },
        before:   { status: existing.status },
        after:    { status: 'archived', isArchived: true },
        context:  { req }
      });

      res.json({ template });
    } catch (err) { next(err); }
  },

  async publish(req, res, next) {
    try {
      const { template, version } = await templateService.publish(req.params.id, req.user.id);

      ragAuditService.log({
        action:   'TEMPLATE_PUBLISHED',
        actor:    req.user,
        resource: { type: 'template', id: template._id },
        before:   { status: 'draft' },
        after:    { status: 'published' },
        context:  { req }
      });

      res.json({ template, version });
    } catch (err) { next(err); }
  },

  async listVersions(req, res, next) {
    try {
      const versions = await templateService.listVersions(req.params.id);
      res.json({ versions });
    } catch (err) { next(err); }
  },

  async getVersion(req, res, next) {
    try {
      const version = await templateService.getVersion(req.params.id, req.params.vId);
      if (!version) return res.status(404).json({ error: 'VERSION_NOT_FOUND' });
      res.json({ version });
    } catch (err) { next(err); }
  }
};

module.exports = { templateController };
