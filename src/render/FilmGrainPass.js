import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// Subtle animated grain over the *final* frame — the oldest compositing trick
// for marrying CG to camera footage. The webcam layer already carries sensor
// noise; the rendered object is mathematically clean, and that cleanliness is
// a big part of what reads as "pasted on". Regraining the whole frame gives
// both layers the same noise floor. Weighted toward the shadows/mids where
// real sensor noise lives; highlights stay clean.
//
// Runs after OutputPass, i.e. in display-referred sRGB, which is where camera
// grain actually exists.
export function createFilmGrainPass(amount) {
  const pass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uAmount: { value: amount },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float uTime;
      uniform float uAmount;
      varying vec2 vUv;

      // Cheap per-pixel hash; reseeded per frame by uTime so the grain crawls
      // like sensor noise instead of sitting as a static texture.
      float hash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      void main() {
        vec4 c = texture2D(tDiffuse, vUv);
        float n = hash(gl_FragCoord.xy + fract(uTime) * 1024.0) - 0.5;
        float luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
        c.rgb += n * uAmount * (0.35 + 0.65 * (1.0 - luma));
        gl_FragColor = c;
      }
    `,
  });
  return pass;
}
