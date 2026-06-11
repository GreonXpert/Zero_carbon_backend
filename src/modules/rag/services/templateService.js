'use strict';

const mongoose        = require('mongoose');
const { v4: uuidv4 }  = require('uuid');
const RagTemplate        = require('../models/RagTemplate');
const RagTemplateVersion = require('../models/RagTemplateVersion');
const { s3RagHelper }    = require('../utils/s3RagHelper');
const { extractSummary } = require('../utils/templateSchemaValidator');

function buildSlug(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function ensureUniqueSlug(base) {
  let slug = base;
  let i    = 1;
  while (await RagTemplate.exists({ slug })) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

const templateService = {
  async createWithVersion({ name, description, type, platform, tags, structure, createdBy }) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const templateId = new mongoose.Types.ObjectId();
      const slug       = await ensureUniqueSlug(buildSlug(name));
      const s3Key      = `templates/${templateId}/v1/template.json`;

      await s3RagHelper.uploadJSON(s3Key, structure);

      const [version] = await RagTemplateVersion.create(
        [{
          templateId,
          version:   1,
          s3Key,
          summary:   extractSummary(structure),
          status:    'draft',
          createdBy
        }],
        { session }
      );

      const [template] = await RagTemplate.create(
        [{
          _id:             templateId,
          name, description, type, platform: platform || 'both',
          tags:            tags || [],
          slug,
          currentVersion:  1,
          latestVersionId: version._id,
          status:          'draft',
          createdBy,
          lastEditedBy:    createdBy
        }],
        { session }
      );

      await session.commitTransaction();
      return { template, version };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  },

  async getById(id) {
    return RagTemplate.findById(id).populate('latestVersionId');
  },

  async list({ type, status, platform, page = 1, limit = 20 } = {}) {
    const query = { isArchived: false };
    if (type)     query.type     = type;
    if (status)   query.status   = status;
    if (platform) query.platform = { $in: [platform, 'both'] };

    const skip  = (page - 1) * limit;
    const [templates, total] = await Promise.all([
      RagTemplate.find(query)
        .populate('latestVersionId', 'version status s3Key summary')
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      RagTemplate.countDocuments(query)
    ]);
    return { templates, total, page, pages: Math.ceil(total / limit) };
  },

  async createNewVersion({ templateId, structure, changelog, createdBy }) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const template = await RagTemplate.findById(templateId).session(session);
      if (!template) throw new Error('Template not found');

      const newVersion = template.currentVersion + 1;
      const s3Key      = `templates/${templateId}/v${newVersion}/template.json`;

      await s3RagHelper.uploadJSON(s3Key, structure);

      const [version] = await RagTemplateVersion.create(
        [{
          templateId,
          version:   newVersion,
          s3Key,
          summary:   extractSummary(structure),
          changelog: changelog || '',
          status:    'draft',
          createdBy
        }],
        { session }
      );

      template.currentVersion  = newVersion;
      template.latestVersionId = version._id;
      template.lastEditedBy    = createdBy;
      template.status          = 'draft';
      await template.save({ session });

      await session.commitTransaction();
      return { template, version };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  },

  async publish(templateId, userId) {
    const template = await RagTemplate.findById(templateId);
    if (!template) throw new Error('Template not found');

    const version = await RagTemplateVersion.findById(template.latestVersionId);
    if (!version) throw new Error('Template version not found');

    template.status          = 'published';
    template.lastEditedBy    = userId;
    version.status           = 'published';
    version.publishedAt      = new Date();

    await Promise.all([template.save(), version.save()]);
    return { template, version };
  },

  async archive(templateId, userId) {
    const template = await RagTemplate.findByIdAndUpdate(
      templateId,
      { status: 'archived', isArchived: true, lastEditedBy: userId },
      { new: true }
    );
    if (!template) throw new Error('Template not found');
    return template;
  },

  async getPublishedVersion(templateId, versionId) {
    const template = await RagTemplate.findById(templateId);
    if (!template || template.status !== 'published') return null;

    if (versionId) {
      return RagTemplateVersion.findOne({
        _id:        versionId,
        templateId: templateId,
        status:     'published'
      });
    }

    // Prefer latestVersionId if it exists and is published.
    // Fall back to the most-recent published version otherwise
    // (handles the case where latestVersionId points to a draft after createNewVersion).
    if (template.latestVersionId) {
      const latest = await RagTemplateVersion.findOne({
        _id:        template.latestVersionId,
        templateId: templateId,
        status:     'published'
      });
      if (latest) return latest;
    }

    // Any published version for this template — take the highest version number
    return RagTemplateVersion.findOne({
      templateId: templateId,
      status:     'published'
    }).sort({ version: -1 });
  },

  async listVersions(templateId) {
    return RagTemplateVersion.find({ templateId }).sort({ version: -1 }).lean();
  },

  async getVersion(templateId, versionId) {
    return RagTemplateVersion.findOne({ _id: versionId, templateId });
  }
};

module.exports = { templateService };
