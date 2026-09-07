const uniforms = `
uniform vec2 uSize;
uniform float uDpr;
uniform float uTime;
uniform float uIntensity;
uniform vec3 uColors[5];
uniform vec4 uOcclusion;
uniform float uHighlight;
`
const fragmentHelpers = `
void skipCoveredPixels() {
  vec2 p = vec2(gl_FragCoord.x / uDpr, uSize.y - gl_FragCoord.y / uDpr);
  if (p.x > uOcclusion.x && p.y > uOcclusion.y && p.x < uOcclusion.z && p.y < uOcclusion.w) discard;
}
vec3 palette(float slot) {
  vec3 color = uColors[0];
  if (slot > .5) color = uColors[1];
  if (slot > 1.5) color = uColors[2];
  if (slot > 2.5) color = uColors[3];
  if (slot > 3.5) color = uColors[4];
  return color;
}
float emphasis(float slot) { return uHighlight < -.5 || abs(slot - uHighlight) < .5 ? 1. : .18; }
`

export const starVertex = `
precision highp float;
attribute vec4 aPosition; // normalized x/y, radius, opacity
attribute vec4 aDetails; // phase, theme slot, depth, bright core
${uniforms}
varying vec4 vStar; // radius, sprite width in CSS pixels, alpha, slot
varying float vCore;
void main() {
  float radius = aPosition.z;
  float alpha = aPosition.w;
  vec2 drift = vec2(sin(uTime * .055) * uSize.x * .006, sin(uTime * .043) * uSize.y * .004);
  vec2 position = (aPosition.xy * 1.02 - .01) * uSize + drift * aDetails.z;
  if (aDetails.w > .5) {
    radius *= .97 + .035 * sin(uTime * .9 + aDetails.x);
    alpha = .78 + .20 * sin(uTime * (.62 + aPosition.z * .13) + aDetails.x);
  } else if (aDetails.z > 1.) {
    alpha *= .74 + .26 * sin(uTime * (.65 + mod(aDetails.x, 7.) * .08) + aDetails.x);
  }
  float diameter = aDetails.w > .5 ? radius * 28. : radius * 2. + 2. / uDpr;
  gl_Position = vec4(position.x / uSize.x * 2. - 1., 1. - position.y / uSize.y * 2., 0., 1.);
  gl_PointSize = diameter * uDpr;
  vStar = vec4(radius, diameter, alpha, aDetails.y);
  vCore = aDetails.w;
}
`

export const starFragment = `
precision highp float;
${uniforms}
${fragmentHelpers}
varying vec4 vStar;
varying float vCore;
void main() {
  skipCoveredPixels();
  vec2 p = (gl_PointCoord - .5) * vStar.y;
  float distance = length(p);
  float disc = 1. - smoothstep(vStar.x - .5 / uDpr, vStar.x + .5 / uDpr, distance);
  float alpha = disc;
  if (vCore > .5) {
    float radius = distance / vStar.x;
    float halo = radius < 2.8 ? mix(.333, .133, radius / 2.8) : .133 * (1. - smoothstep(2.8, 14., radius));
    float cross = (1. - smoothstep(.15, .65, min(abs(p.x), abs(p.y)))) * (1. - smoothstep(vStar.x * 5., vStar.x * 6., max(abs(p.x), abs(p.y)))) * .55;
    alpha = 1. - (1. - disc) * (1. - halo) * (1. - cross);
  }
  alpha = clamp(alpha * vStar.z * uIntensity * emphasis(vStar.w), 0., 1.);
  vec3 color = mix(palette(vStar.w), vec3(1.), .62);
  gl_FragColor = vec4(color * alpha, alpha);
}
`

export const fogVertex = `
attribute vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0., 1.); }
`
export const fogFragment = `
precision highp float;
${uniforms}
${fragmentHelpers}
uniform sampler2D uMain;
uniform sampler2D uDetails;
vec4 cloud(vec2 uv, float opacity) {
  vec4 main = texture2D(uMain, uv);
  vec2 detail = texture2D(uDetails, uv).rg;
  vec3 color = main.r * uColors[0] * emphasis(0.) + main.g * uColors[1] * emphasis(1.) + main.b * uColors[2] * emphasis(2.)
    + detail.r * uColors[3] * emphasis(3.) + detail.g * uColors[4] * emphasis(4.);
  float alpha = clamp(main.a * opacity * uIntensity, 0., 1.);
  return vec4(color * .70 * alpha, alpha);
}
void main() {
  skipCoveredPixels();
  vec2 p = vec2(gl_FragCoord.x / uDpr, uSize.y - gl_FragCoord.y / uDpr) / uSize;
  vec2 drift = vec2(sin(uTime * .085) * .038, sin(uTime * .063) * .033);
  float v = (p.y + .08 - drift.y) / 1.16;
  float bend = sin(v * 6.5 + uTime * .14) * .009 + sin(v * 15. - uTime * .095) * .004;
  vec4 first = cloud(vec2((p.x + .07 - drift.x - bend) / 1.14, v), .95);
  vec4 second = cloud((1. - p + .08 + drift * vec2(.65, .8)) / 1.16, .22);
  gl_FragColor = vec4(first.rgb + second.rgb * (1. - first.rgb), first.a + second.a * (1. - first.a));
}
`
