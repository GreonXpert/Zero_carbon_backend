'use strict';

const mongoose = require('mongoose');
const { encrypt, decrypt } = require('./encryptionUtil');

/**
 * Mongoose plugin that transparently encrypts fields before write
 * and decrypts them after read.
 *
 * Usage (add at the BOTTOM of each model file, after all existing hooks):
 *   const encryptionPlugin = require('./mongooseEncryptionPlugin');
 *   MySchema.plugin(encryptionPlugin, { fields: ['fieldA', 'nested.fieldB'] });
 *
 * Root cause fix:
 *   Mongoose type-casts values on write AND on hydration from MongoDB.
 *   A Number field casts "v1:..." to NaN. A [SubSchema] field casts it to [].
 *   A Map field casts it to an empty Map. Only String fields accept a String.
 *
 *   The plugin overrides ALL encrypted field types to Mixed at registration
 *   time (schema.path(field, Mixed)) so Mongoose stores whatever value it
 *   receives — either the encrypted String or the decrypted original type.
 *
 * Hook ordering guarantee:
 *   Because the plugin is registered LAST (at the bottom of the model file),
 *   all existing pre('save') hooks (calculateCumulativeValues, edge validation,
 *   cumulative math) run first on PLAIN data, then this plugin encrypts.
 *   post('init')/post('find') decrypts BEFORE any subsequent post hooks, so
 *   downstream code always receives plain values.
 */
function encryptionPlugin(schema, options = {}) {
  const fields = options.fields || [];
  if (fields.length === 0) return;

  // ─── Step 1: Override all encrypted field types to Mixed ─────────────────
  //
  //   This is the critical fix. Without this, Mongoose casts "v1:..." to the
  //   declared type (Number → NaN, [Schema] → [], Map → Map{}) and the
  //   encrypted string is lost both on write (pre-save) and on read (init).
  //
  //   Mixed type stores whatever value is assigned — String when encrypted,
  //   original JS type (Number, Array, Map, Object, etc.) when decrypted.

  for (const field of fields) {
    try {
      if (!field.includes('.')) {
        // ── Top-level field (may be a nested schema like 'supportSection') ────
        //
        // ROOT CAUSE FIX (Mongoose 8):
        // schema.path(field, Mixed) overrides the root path BUT leaves all
        // sub-paths ('supportSection.supportManagerHistory', etc.) registered
        // in schema.paths with their original types and defaults.
        //
        // During Client.findOne() / document hydration, Mongoose calls
        // applyDefaults() which iterates schema.pathsWithDefaults and tries to
        // set default values (e.g. supportManagerHistory: []) as properties on
        // whatever value is stored at that path. If supportSection is an
        // encrypted string ("v1:..."), this throws:
        //   TypeError: Cannot create property 'supportManagerHistory' on string 'v1:...'
        //
        // Fix: purge all sub-paths from schema internals so applyDefaults()
        // never tries to navigate into the encrypted string.

        // Step A — delete all sub-paths from schema.paths
        const subPaths = Object.keys(schema.paths).filter(
          p => p === field || p.startsWith(field + '.')
        );
        for (const p of subPaths) {
          delete schema.paths[p];
        }

        // Step B — purge nested-path markers (e.g. 'supportSection.supportMetrics')
        if (schema.nested && typeof schema.nested === 'object') {
          for (const k of Object.keys(schema.nested)) {
            if (k === field || k.startsWith(field + '.')) {
              delete schema.nested[k];
            }
          }
        }

        // Step C — purge singleNestedPaths if present (Mongoose internal map)
        if (schema.singleNestedPaths && typeof schema.singleNestedPaths === 'object') {
          for (const k of Object.keys(schema.singleNestedPaths)) {
            if (k === field || k.startsWith(field + '.')) {
              delete schema.singleNestedPaths[k];
            }
          }
        }

        // Step D — re-register the field as Mixed via schema.add()
        //           (schema.add() is the safe Mongoose API for this)
        schema.add({ [field]: mongoose.Schema.Types.Mixed });

      } else {
        // ── Nested field (e.g. 'leadInfo.notes'): override the path directly ──
        schema.path(field, { type: mongoose.Schema.Types.Mixed });
      }
    } catch (e) {
      // Path override failed (e.g. path doesn't exist) — log and continue
      console.warn(`[EncryptionPlugin] Could not override type for "${field}": ${e.message}`);
    }
  }

  // ─── Utility: get/set nested value by dot-path ──────────────────────────────

  function getNestedValue(obj, path) {
    return path.split('.').reduce(
      (acc, key) => (acc != null ? acc[key] : undefined),
      obj
    );
  }

  function setNestedValue(obj, path, value) {
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (current[keys[i]] == null) current[keys[i]] = {};
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
  }

  // ─── Serialize Mongoose-specific types to plain JS before encrypting ────────
  //
  //   Mongoose DocumentArrays and Maps serialize to their plain equivalents.
  //   Plain Objects/Arrays are returned as-is.

  function serializeForEncrypt(value) {
    if (value === null || value === undefined) return value;
    // Mongoose DocumentArray / Array of subdocs → plain array of plain objects
    if (Array.isArray(value)) {
      return value.map(item =>
        item && typeof item.toObject === 'function' ? item.toObject() : item
      );
    }
    // Mongoose Document (single subdoc) → plain object
    if (typeof value === 'object' && typeof value.toObject === 'function') {
      return value.toObject();
    }
    // Mongoose Map → plain object (encryptionUtil handles Map separately)
    // Regular Map → kept as-is (encryptionUtil handles it with 'm' prefix)
    return value;
  }

  // ─── Encrypt all configured fields on a Mongoose Document or plain object ───

  function encryptFields(doc) {
    if (!doc || typeof doc !== 'object') return;
    for (const field of fields) {
      const raw = getNestedValue(doc, field);
      if (raw !== undefined && raw !== null) {
        const plain = serializeForEncrypt(raw);
        setNestedValue(doc, field, encrypt(plain));
      }
    }
  }

  // ─── Decrypt all configured fields on a Mongoose Document or plain object ───

  function decryptFields(doc) {
    if (!doc || typeof doc !== 'object') return;
    for (const field of fields) {
      const value = getNestedValue(doc, field);
      if (value !== undefined && value !== null) {
        setNestedValue(doc, field, decrypt(value));
      }
    }
  }

  // ─── HOOK 1: pre('save') ─────────────────────────────────────────────────────
  //
  //   Encrypts fields just before MongoDB writes the document.
  //   Runs AFTER all previously registered pre('save') hooks because the plugin
  //   is added last via schema.plugin() at the bottom of the model file.

  schema.pre('save', function (next) {
    try {
      encryptFields(this);
      return next();
    } catch (err) {
      return next(err);
    }
  });

  // ─── HOOK 2: post('save') ────────────────────────────────────────────────────
  //
  //   Decrypts the document back in-memory immediately after the write.
  //   Existing post('save') hooks (updateSummariesOnDataChange, etc.) that
  //   run after this hook will receive plain (decrypted) values.

  schema.post('save', function (doc) {
    if (doc) decryptFields(doc);
  });

  // ─── HOOK 3: post('init') ────────────────────────────────────────────────────
  //
  //   Fires when Mongoose hydrates a Document instance from raw MongoDB data.
  //   With fields now typed as Mixed, Mongoose stores the encrypted String
  //   as-is and this hook decrypts it back to the original JS type.

  schema.post('init', function (doc) {
    if (doc) decryptFields(doc);
  });

  // ─── HOOK 4: post('find') ────────────────────────────────────────────────────
  //
  //   Fires for BOTH lean and non-lean find() queries.
  //   Critical for DataEntry.find(query).lean() inside calculateEmissionSummary()
  //   in CalculationSummary.js — lean queries skip post('init').

  schema.post('find', function (docs) {
    if (Array.isArray(docs)) {
      for (const doc of docs) {
        decryptFields(doc);
      }
    }
  });

  // ─── HOOK 5: post('findOne') ─────────────────────────────────────────────────

  schema.post('findOne', function (doc) {
    if (doc) decryptFields(doc);
  });

  // ─── HOOK 6: pre('findOneAndUpdate') ─────────────────────────────────────────
  //
  //   Encrypts the update payload before MongoDB write.

  schema.pre('findOneAndUpdate', function (next) {
    try {
      encryptUpdatePayload(this.getUpdate());
      return next();
    } catch (err) {
      return next(err);
    }
  });

  // ─── HOOK 7: post('findOneAndUpdate') ────────────────────────────────────────

  schema.post('findOneAndUpdate', function (doc) {
    if (doc) decryptFields(doc);
  });

  // ─── HOOK 8: pre('updateOne') / pre('updateMany') ────────────────────────────

  schema.pre('updateOne', function (next) {
    try {
      encryptUpdatePayload(this.getUpdate());
      return next();
    } catch (err) {
      return next(err);
    }
  });

  schema.pre('updateMany', function (next) {
    try {
      encryptUpdatePayload(this.getUpdate());
      return next();
    } catch (err) {
      return next(err);
    }
  });

  // ─── HOOK 9: pre('insertMany') ───────────────────────────────────────────────

  schema.pre('insertMany', function (next, docs) {
    try {
      if (Array.isArray(docs)) {
        for (const doc of docs) {
          encryptFields(doc);
        }
      }
      return next();
    } catch (err) {
      return next(err);
    }
  });

  // ─── Helper: encrypt fields inside a Mongoose update object ─────────────────

  function encryptUpdatePayload(update) {
    if (!update) return;

    if (update.$set) {
      encryptOperatorObject(update.$set);
    }
    if (update.$setOnInsert) {
      encryptOperatorObject(update.$setOnInsert);
    }

    // Plain replacement document (no $ operators at top level)
    const isReplacement = !Object.keys(update).some(k => k.startsWith('$'));
    if (isReplacement) {
      encryptFields(update);
    }
  }

  function encryptOperatorObject(operatorObj) {
    if (!operatorObj || typeof operatorObj !== 'object') return;

    for (const field of fields) {
      // Pattern A: exact key match
      if (operatorObj[field] !== undefined && operatorObj[field] !== null) {
        operatorObj[field] = encrypt(serializeForEncrypt(operatorObj[field]));
        continue;
      }

      // Pattern B: dot-notation key in operator matches an encrypted field
      for (const key of Object.keys(operatorObj)) {
        if (key === field) continue;
        if (key.startsWith(field + '.') || key === field) {
          if (operatorObj[key] !== undefined && operatorObj[key] !== null) {
            operatorObj[key] = encrypt(serializeForEncrypt(operatorObj[key]));
          }
        }
      }

      // Pattern C: encrypted field is a sub-path and operator has parent object
      const topKey = field.split('.')[0];
      if (topKey !== field && operatorObj[topKey] !== undefined) {
        const subPath = field.slice(topKey.length + 1);
        const subVal = getNestedValue(operatorObj[topKey], subPath);
        if (subVal !== undefined && subVal !== null) {
          setNestedValue(operatorObj[topKey], subPath, encrypt(serializeForEncrypt(subVal)));
        }
      }
    }
  }
}

module.exports = encryptionPlugin;