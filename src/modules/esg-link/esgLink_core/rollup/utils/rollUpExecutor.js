'use strict';

/**
 * Safe rollUpBehavior handler registry.
 * Never executes dynamic expressions from the database.
 * All behavior logic lives here in code.
 */

const HANDLERS = {
  sum: (values) => {
    const valid = values.filter((v) => v != null && isFinite(v));
    return valid.length ? valid.reduce((a, b) => a + b, 0) : 0;
  },
  average: (values) => {
    const valid = values.filter((v) => v != null && isFinite(v));
    return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
  },
};

/**
 * Execute a rollup behavior against an array of numeric values.
 * @param {string} behavior - e.g. 'sum' | 'average'
 * @param {number[]} values - per-node values
 * @returns {number}
 */
function execute(behavior, values) {
  const key = (behavior || 'sum').toLowerCase();
  if (!HANDLERS[key]) {
    return HANDLERS.sum(values);
  }
  return HANDLERS[key](values);
}

function getRegisteredCodes() {
  return Object.keys(HANDLERS);
}

function isSupported(behavior) {
  return Object.prototype.hasOwnProperty.call(HANDLERS, (behavior || '').toLowerCase());
}

module.exports = { execute, getRegisteredCodes, isSupported };
