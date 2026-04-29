'use strict';

const EsgFramework        = require('../models/Framework.model');
const EsgFrameworkSection = require('../models/FrameworkSection.model');

const BRSR_SECTIONS = [
  { sectionCode: 'A', sectionName: 'General Disclosures', displayOrder: 1, parentSectionCode: null, principleCode: null },
  { sectionCode: 'B', sectionName: 'Management and Process Disclosures', displayOrder: 2, parentSectionCode: null, principleCode: null },
  { sectionCode: 'C', sectionName: 'Principle-wise Performance Disclosure', displayOrder: 3, parentSectionCode: null, principleCode: null },
  // Section C sub-sections (one per principle)
  { sectionCode: 'C-P1', sectionName: 'Principle 1 — Businesses should conduct and govern themselves with integrity, and in a manner that is Ethical, Transparent and Accountable', displayOrder: 4, parentSectionCode: 'C', principleCode: 'P1' },
  { sectionCode: 'C-P2', sectionName: 'Principle 2 — Businesses should provide goods and services in a manner that is sustainable and safe', displayOrder: 5, parentSectionCode: 'C', principleCode: 'P2' },
  { sectionCode: 'C-P3', sectionName: 'Principle 3 — Businesses should respect and promote the well-being of all employees, including those in their value chains', displayOrder: 6, parentSectionCode: 'C', principleCode: 'P3' },
  { sectionCode: 'C-P4', sectionName: 'Principle 4 — Businesses should respect the interests of and be responsive to all its stakeholders', displayOrder: 7, parentSectionCode: 'C', principleCode: 'P4' },
  { sectionCode: 'C-P5', sectionName: 'Principle 5 — Businesses should respect and promote human rights', displayOrder: 8, parentSectionCode: 'C', principleCode: 'P5' },
  { sectionCode: 'C-P6', sectionName: 'Principle 6 — Businesses should respect and make efforts to protect and restore the environment', displayOrder: 9, parentSectionCode: 'C', principleCode: 'P6' },
  { sectionCode: 'C-P7', sectionName: 'Principle 7 — Businesses, when engaging in influencing public and regulatory policy, should do so in a manner that is responsible and transparent', displayOrder: 10, parentSectionCode: 'C', principleCode: 'P7' },
  { sectionCode: 'C-P8', sectionName: 'Principle 8 — Businesses should promote inclusive growth and equitable development', displayOrder: 11, parentSectionCode: 'C', principleCode: 'P8' },
  { sectionCode: 'C-P9', sectionName: 'Principle 9 — Businesses should engage with and provide value to their consumers in a responsible manner', displayOrder: 12, parentSectionCode: 'C', principleCode: 'P9' },
];

/**
 * seedBrsr
 * Creates the BRSR Framework and its sections if they do not already exist.
 * Fully idempotent — safe to call multiple times.
 *
 * @param {ObjectId} createdBy - admin user ID performing the seed
 * @returns {Promise<{ framework: object, sections: object[] }>}
 */
const seedBrsr = async (createdBy) => {
  let framework = await EsgFramework.findOne({ frameworkCode: 'BRSR' }).lean();

  if (!framework) {
    framework = await EsgFramework.create({
      frameworkCode: 'BRSR',
      frameworkName: 'Business Responsibility and Sustainability Reporting',
      frameworkType: 'mandatory',
      country:       'India',
      authority:     'SEBI',
      description:   'BRSR framework mandated by SEBI for top listed companies in India (effective FY 2022-23).',
      version:       '2023-24',
      status:        'active',
      createdBy,
    });
  }

  const createdSections = [];

  for (const sec of BRSR_SECTIONS) {
    const exists = await EsgFrameworkSection.findOne({
      frameworkCode: 'BRSR',
      sectionCode:   sec.sectionCode,
    }).lean();

    if (!exists) {
      let parentSectionId = null;
      if (sec.parentSectionCode) {
        const parent = await EsgFrameworkSection.findOne({
          frameworkCode: 'BRSR',
          sectionCode:   sec.parentSectionCode,
        }).lean();
        parentSectionId = parent ? parent._id : null;
      }

      const created = await EsgFrameworkSection.create({
        frameworkId:       framework._id,
        frameworkCode:     'BRSR',
        sectionCode:       sec.sectionCode,
        sectionName:       sec.sectionName,
        parentSectionId,
        parentSectionCode: sec.parentSectionCode || null,
        principleCode:     sec.principleCode     || null,
        displayOrder:      sec.displayOrder,
      });
      createdSections.push(created);
    }
  }

  return { framework, sectionsCreated: createdSections.length };
};

module.exports = { seedBrsr };
