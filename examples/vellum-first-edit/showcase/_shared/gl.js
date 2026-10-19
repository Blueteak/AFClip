// Fullscreen WebGL2 pass shared by the showcase shaders. Staged next to each
// asset's index.html at import so every package stays self-contained.
// Inputs are ImageBitmaps: row 0 is the top, so shaders sample with `st`.
window.AFGL = (canvas, body) => {
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true, antialias: false });
  if (!gl) throw new Error('WebGL2 unavailable');
  const head = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform vec2 res; uniform float progress, time, duration, seed;
uniform sampler2D tex0, tex1;
#define PI 3.14159265
vec2 st;
float aspect() { return res.x / res.y; }
vec4 A(vec2 p) { return texture(tex0, p); }
vec4 B(vec2 p) { return texture(tex1, p); }
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32 + seed * .001); return fract(p.x * p.y); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float v = 0., a = .5; for (int i = 0; i < 6; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= .5; } return v; }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
vec2 mirror(vec2 p) { return 1. - abs(1. - mod(p, 2.)); }
float ease(float x) { x = clamp(x, 0., 1.); return x * x * (3. - 2. * x); }
`;
  const compile = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, `#version 300 es
in vec2 p; out vec2 uv; void main() { uv = p * .5 + .5; gl_Position = vec4(p, 0, 1); }`));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, head + body.replace('void main() {', 'void main() { st = vec2(uv.x, 1. - uv.y);')));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const textures = [0, 1].map(i => {
    const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.uniform1i(gl.getUniformLocation(program, 'tex' + i), i);
    return t;
  });
  const uniforms = new Map(), at = name => { if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(program, name)); return uniforms.get(name); };
  const color = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  return (c, extra = {}) => {
    if (canvas.width !== c.width) canvas.width = c.width;
    if (canvas.height !== c.height) canvas.height = c.height;
    gl.viewport(0, 0, c.width, c.height);
    c.inputs.forEach((image, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, textures[i]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image); });
    gl.uniform2f(at('res'), c.width, c.height);
    for (const [k, v] of Object.entries({ progress: c.progress, time: c.time, duration: c.duration || 0, seed: c.seed || 0 })) gl.uniform1f(at(k), v);
    for (const [k, raw] of Object.entries(extra)) {
      const v = typeof raw === 'string' ? color(raw) : typeof raw === 'boolean' ? +raw : raw;
      if (Array.isArray(v)) gl[`uniform${v.length}fv`](at(k), v); else gl.uniform1f(at(k), v);
    }
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return canvas;
  };
};
