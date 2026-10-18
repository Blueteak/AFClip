// Shared by the engine and browser. Parameter values are evaluated before render.
(function (root) {
  function manifest(value) {
    if (!value || value.apiVersion !== 1 || !['content', 'transition', 'effect'].includes(value.role) || typeof value.name !== 'string') throw new Error('asset.json requires apiVersion: 1, role, and name');
    const fields = value.parameters || {};
    if (typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Asset parameters must be an object');
    for (const [id, field] of Object.entries(fields)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/.test(id) || !['number','boolean','color','text','choice'].includes(field.type)) throw new Error(`Invalid asset parameter ${id}`);
      if (field.type === 'choice' && (!Array.isArray(field.choices) || !field.choices.length || !field.choices.every(v => typeof v === 'string'))) throw new Error(`Invalid choices for ${id}`);
      for (const key of ['min','max','step']) if (field[key] !== undefined && !Number.isFinite(field[key])) throw new Error(`Invalid ${key} for ${id}`);
      check(id, field, field.default);
    }
    return value;
  }
  function check(id, field, value) {
    const valid = field.type === 'number' ? typeof value === 'number' && Number.isFinite(value) && (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max)
      : field.type === 'boolean' ? typeof value === 'boolean'
      : field.type === 'choice' ? field.choices.includes(value)
      : field.type === 'color' ? typeof value === 'string' && /^#[\da-f]{6}([\da-f]{2})?$/i.test(value)
      : typeof value === 'string' && value.length <= 16384;
    if (!valid) throw new Error(`Invalid value for asset parameter "${id}"`);
  }
  function parameters(asset, overrides = {}) {
    manifest(asset);
    const result = {}, fields = asset.parameters || {};
    for (const id of Object.keys(overrides)) if (!Object.hasOwn(fields, id)) throw new Error(`Asset parameter "${id}" no longer exists`);
    for (const [id, field] of Object.entries(fields)) { const value = Object.hasOwn(overrides, id) ? overrides[id] : field.default; check(id, field, value); result[id] = value; }
    return result;
  }
  const api = { manifest, parameters };
  if (typeof module !== 'undefined') module.exports = api; else root.AFClipAssetSchema = api;
})(globalThis);
