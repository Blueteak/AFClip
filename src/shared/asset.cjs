// Shared by the engine and browser. Parameter values are evaluated before render.
(function (root) {
  const ID = /^[a-zA-Z0-9_-]{1,128}$/, TYPES = ['number','boolean','color','text','choice'];
  // Named easings expand to explicit cubic-bezier handles when written. Y beyond 0..1 overshoots.
  const EASINGS = { ease:[.25,.1,.25,1], 'ease-in':[.42,0,1,1], 'ease-out':[0,0,.58,1], 'ease-in-out':[.42,0,.58,1],
    'back-in':[.36,0,.66,-.56], 'back-out':[.34,1.56,.64,1], 'back-in-out':[.68,-.6,.32,1.6] };
  const animatable = field => field.type === 'number' || field.type === 'color';
  const sec = t => typeof t === 'number' ? t : t.num / t.den;
  function ease(value) {
    if (value === undefined || value === 'linear') return undefined;
    if (value === 'hold') return 'hold';
    if (typeof value === 'string' && EASINGS[value]) return [...EASINGS[value]];
    if (Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value[0] >= 0 && value[0] <= 1 && value[2] >= 0 && value[2] <= 1 && Math.abs(value[1]) <= 10 && Math.abs(value[3]) <= 10) return [...value];
    throw new Error(`Ease must be linear, hold, ${Object.keys(EASINGS).join(', ')} or [x1,y1,x2,y2] with x in 0..1`);
  }
  function easeName(value) {
    if (value === undefined || value === 'hold') return value || 'linear';
    const name = Object.keys(EASINGS).find(k => EASINGS[k].every((v, i) => Math.abs(v - value[i]) < 1e-9));
    return name || value;
  }
  function check(id, field, value) {
    const valid = field.type === 'number' ? typeof value === 'number' && Number.isFinite(value) && (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max) && (!field.integer || Number.isInteger(value))
      : field.type === 'boolean' ? typeof value === 'boolean'
      : field.type === 'choice' ? field.choices.includes(value)
      : field.type === 'color' ? typeof value === 'string' && /^#[\da-f]{6}([\da-f]{2})?$/i.test(value)
      : typeof value === 'string' && value.length <= 16384;
    if (!valid) throw new Error(`Invalid value for asset parameter "${id}"` + (field.type === 'number' ? ` (number${field.integer ? ', integer' : ''}${field.min !== undefined ? `, min ${field.min}` : ''}${field.max !== undefined ? `, max ${field.max}` : ''})` : field.type === 'color' ? ' (#rrggbb or #rrggbbaa)' : field.type === 'choice' ? ` (${field.choices.join(', ')})` : ''));
  }
  // Declarations use percentages of the instance's bound span; instances store exact times.
  function checkPoints(id, field, points, percent) {
    if (!animatable(field)) throw new Error(`Parameter "${id}" cannot be animated`);
    if (!Array.isArray(points) || !points.length || points.length > 1000) throw new Error(`Curve for "${id}" needs 1 to 1000 points`);
    let previous = -Infinity;
    for (const point of points) {
      if (!point || typeof point !== 'object' || Object.keys(point).some(k => !['t','at','v','ease'].includes(k))) throw new Error(`Invalid curve point for "${id}"`);
      const at = percent ? (typeof point.at === 'string' && /^-?\d+(\.\d+)?%$/.test(point.at) ? parseFloat(point.at) : NaN)
        : point.t && Number.isSafeInteger(point.t.num) && Number.isSafeInteger(point.t.den) && point.t.den > 0 ? sec(point.t) : NaN;
      if (!Number.isFinite(at) || at <= previous) throw new Error(`Curve points for "${id}" need ${percent ? 'increasing "N%" at values' : 'increasing {num,den} t values'}`);
      if ((percent && point.t !== undefined) || (!percent && point.at !== undefined)) throw new Error(`Invalid curve point for "${id}"`);
      check(id, field, point.v);
      if (point.ease !== undefined) { const stored = ease(point.ease); if (!percent && JSON.stringify(stored) !== JSON.stringify(point.ease)) throw new Error(`Stored ease for "${id}" must be "hold" or [x1,y1,x2,y2]`); }
      previous = at;
    }
  }
  const isCurve = value => !!value && typeof value === 'object' && !Array.isArray(value);
  function manifest(value) {
    if (!value || value.apiVersion !== 1 || !['content', 'transition', 'effect'].includes(value.role) || typeof value.name !== 'string') throw new Error('asset.json requires apiVersion: 1, role, and name');
    const fields = value.parameters || {};
    if (typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Asset parameters must be an object');
    for (const [id, field] of Object.entries(fields)) {
      if (!ID.test(id) || !field || !TYPES.includes(field.type)) throw new Error(`Invalid asset parameter ${id}`);
      if (field.type === 'choice' && (!Array.isArray(field.choices) || !field.choices.length || !field.choices.every(v => typeof v === 'string'))) throw new Error(`Invalid choices for ${id}`);
      for (const key of ['min','max','step','softMin','softMax']) if (field[key] !== undefined && !Number.isFinite(field[key])) throw new Error(`Invalid ${key} for ${id}`);
      for (const key of ['min','max','step','softMin','softMax','integer','unit','slider']) if (field[key] !== undefined && field.type !== 'number') throw new Error(`${key} applies only to number parameter ${id}`);
      if (field.label !== undefined && (typeof field.label !== 'string' || field.label.length > 64)) throw new Error(`Invalid label for ${id}`);
      if (field.unit !== undefined && (typeof field.unit !== 'string' || field.unit.length > 12)) throw new Error(`Invalid unit for ${id}`);
      for (const key of ['integer','slider']) if (field[key] !== undefined && typeof field[key] !== 'boolean') throw new Error(`${key} must be boolean for ${id}`);
      if (field.step !== undefined && field.step <= 0) throw new Error(`Invalid step for ${id}`);
      const lo = field.softMin ?? field.min, hi = field.softMax ?? field.max;
      if ((field.min ?? -Infinity) > (field.max ?? Infinity) || (lo !== undefined && hi !== undefined && lo >= hi)) throw new Error(`Invalid range for ${id}`);
      for (const key of ['softMin','softMax']) if (field[key] !== undefined && ((field.min !== undefined && field[key] < field.min) || (field.max !== undefined && field[key] > field.max))) throw new Error(`${key} for ${id} must lie within min and max`);
      if (field.slider && !(Number.isFinite(lo) && Number.isFinite(hi))) throw new Error(`Slider ${id} needs softMin/softMax or min/max`);
      // Text defaults may come from the matching data-text element instead.
      if (field.type === 'text' && field.default === undefined) continue;
      if (isCurve(field.default)) {
        if (Object.keys(field.default).some(k => k !== 'curve')) throw new Error(`Curve default for ${id} accepts only curve`);
        checkPoints(id, field, field.default.curve, true);
      } else check(id, field, field.default);
    }
    return value;
  }
  // An override is a constant, {curve} or {curve,value}: value keeps the curve inactive.
  function override(id, field, value) {
    if (!isCurve(value)) return check(id, field, value);
    if (Object.keys(value).some(k => k !== 'curve' && k !== 'value')) throw new Error(`Invalid override for "${id}"`);
    checkPoints(id, field, value.curve, false);
    if (Object.hasOwn(value, 'value')) check(id, field, value.value);
  }
  // Curve points in evaluation coordinates, or null for a constant.
  function curve(field, value, span = [0, 1]) {
    if (value === undefined) value = field.default;
    if (!isCurve(value) || Object.hasOwn(value, 'value')) return null;
    if (value.curve[0]?.at !== undefined) return value.curve.map(p => ({ x: span[0] + parseFloat(p.at) / 100 * (span[1] - span[0]), v: p.v, ease: ease(p.ease) }));
    return value.curve.map(p => ({ x: sec(p.t), v: p.v, ease: p.ease }));
  }
  function bezier([x1, y1, x2, y2], u) {
    const f = (a, b, s) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
    let lo = 0, hi = 1, s = u;
    for (let i = 0; i < 8; i++) { const x = f(x1, x2, s) - u, d = 3 * x1 * (1 - s) ** 2 + 6 * (x2 - x1) * s * (1 - s) + 3 * (1 - x2) * s * s; if (Math.abs(x) < 1e-7) return f(y1, y2, s); if (Math.abs(d) < 1e-6) break; s -= x / d; if (s < 0 || s > 1) break; }
    s = u; for (let i = 0; i < 40; i++) { const x = f(x1, x2, s); if (Math.abs(x - u) < 1e-7) break; if (x < u) lo = s; else hi = s; s = (lo + hi) / 2; }
    return f(y1, y2, s);
  }
  const lin = c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4, gam = c => c <= .0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - .055;
  function oklab(hex) {
    const [r, g, b] = [1, 3, 5].map(i => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
    const [l, m, s] = [.4122214708 * r + .5363325363 * g + .0514459929 * b, .2119034982 * r + .6806995451 * g + .1073969566 * b, .0883024619 * r + .2817188376 * g + .6299787005 * b].map(Math.cbrt);
    return [.2104542553 * l + .793617785 * m - .0040720468 * s, 1.9779984951 * l - 2.428592205 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .808675766 * s, hex.length > 7 ? parseInt(hex.slice(7, 9), 16) / 255 : 1];
  }
  // Perceptual OKLab blend; alpha interpolates independently.
  function mixColor(a, b, u) {
    const A = oklab(a), B = oklab(b), [L, M, S, alpha] = A.map((v, i) => v + (B[i] - v) * u);
    const [l, m, s] = [L + .3963377774 * M + .2158037573 * S, L - .1055613458 * M - .0638541728 * S, L - .0894841775 * M - 1.291485548 * S].map(v => v ** 3);
    const rgb = [4.0767416621 * l - 3.3077115913 * m + .2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s, -.0041960863 * l - .7034186147 * m + 1.707614701 * s];
    const byte = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0'), a8 = byte(alpha);
    return '#' + rgb.map(v => byte(gam(Math.max(0, Math.min(1, v))))).join('') + (a8 === 'ff' && a.length === 7 && b.length === 7 ? '' : a8);
  }
  function sample(field, points, x) {
    let i = 0;
    if (x <= points[0].x) return points[0].v;
    if (x >= points[points.length - 1].x) return points[points.length - 1].v;
    while (x >= points[i + 1].x) i++;
    const a = points[i], b = points[i + 1], u = (x - a.x) / (b.x - a.x);
    if (a.ease === 'hold') return a.v;
    const k = a.ease ? bezier(a.ease, u) : u;
    return field.type === 'color' ? mixColor(a.v, b.v, k) : a.v + (b.v - a.v) * k;
  }
  // Hard bounds and integer rounding also apply to overshoot between points.
  function evaluate(field, value, x = 0, span) {
    const points = curve(field, value, span);
    let result = points ? sample(field, points, x) : isCurve(value) ? value.value : value === undefined ? field.default : value;
    if (field.type === 'number' && typeof result === 'number') {
      if (field.integer) result = Math.round(result);
      result = Math.max(field.min ?? -Infinity, Math.min(field.max ?? Infinity, result));
    }
    return result;
  }
  // Removed parameters are ignored; undeclared strings remain data-text overrides.
  function parameters(asset, overrides = {}, context = {}) {
    manifest(asset);
    const result = {}, fields = asset.parameters || {};
    for (const [id, field] of Object.entries(fields)) {
      const value = Object.hasOwn(overrides || {}, id) ? overrides[id] : undefined;
      if (value !== undefined) override(id, field, value);
      const evaluated = evaluate(field, value, context.x, context.span);
      if (evaluated !== undefined) result[id] = evaluated;
    }
    return result;
  }
  function textValues(asset, overrides = {}) {
    const fields = asset?.parameters || {}, text = {};
    for (const [id, value] of Object.entries(overrides || {})) if (typeof value === 'string' && (!Object.hasOwn(fields, id) || fields[id].type === 'text')) text[id] = value;
    for (const [id, field] of Object.entries(fields)) if (field.type === 'text' && field.default !== undefined && !Object.hasOwn(text, id)) text[id] = field.default;
    return text;
  }
  const span = (instance, fallback) => instance?.paramSpan ? [sec(instance.paramSpan.start), sec(instance.paramSpan.end)] : fallback;
  const hasCurveDefault = asset => Object.values(asset?.parameters || {}).some(f => isCurve(f.default));
  const api = { manifest, parameters, override, evaluate, curve, textValues, ease, easeName, mixColor, animatable, isCurve, span, hasCurveDefault, EASINGS };
  if (typeof module !== 'undefined') module.exports = api; else root.AFClipAssetSchema = api;
})(globalThis);
