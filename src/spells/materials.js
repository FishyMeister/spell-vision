import * as THREE from 'three';

// Soft additive point-sprite material with a 3-stop color gradient driven by
// each particle's normalized age (vLife: 0 = just born, 1 = dead). The gradient
// is what lets one system read as fire (white→orange→red) vs. ice, etc.
//
// Bloom does the heavy "glow" lifting downstream; here we just emit bright,
// additively-blended soft dots and fade them out over life.
export function createParticleMaterial({
  colorHot,
  colorMid,
  colorCool,
  sizeScale = 1.0,
  softness = 1.6,
  fadeIn = 0.12,
}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColorHot: { value: new THREE.Color(colorHot) },
      uColorMid: { value: new THREE.Color(colorMid) },
      uColorCool: { value: new THREE.Color(colorCool) },
      uSizeScale: { value: sizeScale },
      uSoftness: { value: softness },
      uFadeIn: { value: fadeIn },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aLife;   // 0..1 normalized age
      varying float vLife;
      uniform float uSizeScale;
      void main() {
        vLife = aLife;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // perspective sizing; dead particles (aSize 0) vanish
        gl_PointSize = aSize * uSizeScale * (300.0 / max(-mv.z, 0.001));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying float vLife;
      uniform vec3 uColorHot;
      uniform vec3 uColorMid;
      uniform vec3 uColorCool;
      uniform float uSoftness;
      uniform float uFadeIn;
      void main() {
        vec2 uv = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(uv, uv);
        if (r2 > 1.0) discard;
        float glow = pow(max(1.0 - r2, 0.0), uSoftness);

        vec3 col = vLife < 0.5
          ? mix(uColorHot, uColorMid, vLife * 2.0)
          : mix(uColorMid, uColorCool, (vLife - 0.5) * 2.0);

        // quick fade-in at birth, smooth fade-out toward death
        float fin = smoothstep(0.0, uFadeIn, vLife);
        float fout = 1.0 - smoothstep(0.6, 1.0, vLife);
        float alpha = glow * fin * fout;

        gl_FragColor = vec4(col * glow, alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });
}

// Additive shader for simple expanding/fading geometry (rings, beams). alpha is
// driven by a uniform set each frame by the effect.
export function createAdditiveMeshMaterial(color, opacity = 1.0) {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
