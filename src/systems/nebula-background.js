import * as THREE from 'three';

/**
 * Nebula background — a large inside-out sphere textured with a
 * single equirectangular image, following the camera each frame so
 * the player always feels "inside" the nebula.
 *
 * Used as the deep-space backdrop for the play area. The image is
 * shown crisply (`fog: false`) so it reads as a distant scene
 * rather than fading into the same exponential fog that dims the
 * asteroid field.
 *
 * Implementation notes:
 *   - `EquirectangularReflectionMapping` lets a 2D photo (like the
 *     Hubble Horsehead Nebula) wrap around the sphere. The image
 *     will be visibly stretched (it's not a true 360° panorama) —
 *     this is the classic space-sim look.
 *   - `side: BackSide` renders the inside of the sphere, so the
 *     player sees the image when looking outward.
 *   - `renderOrder: -1` + `depthWrite: false` puts the sphere
 *     behind every other opaque object without writing to the
 *     depth buffer (which would clip the near scene).
 *   - `frustumCulled: false` is set on the mesh because the sphere
 *     is intentionally huge (its bounding sphere intersects the
 *     camera frustum at all times). Three.js's default frustum
 *     cull is conservative and would correctly cull it, but we
 *     want the render every frame regardless.
 *
 * Public API:
 *   - `nebula.mount(scene)`         add the mesh to the scene
 *   - `nebula.update(camera)`       follow the camera (call each frame)
 *   - `nebula.setOpacityTarget(t)`   smoothly fade opacity toward `t ∈ [0, 1]`
 *   - `nebula.dispose()`            release geometry + material + texture
 *
 * @param {object} opts
 * @param {string} opts.imageUrl           public-domain image URL (NASA/ESA Hubble)
 * @param {number} [opts.radius=5000]      sphere radius — "far behind" the play area
 * @param {number} [opts.widthSegments=64] sphere width segments
 * @param {number} [opts.heightSegments=32] sphere height segments
 * @returns {{
 *   mesh: THREE.Mesh,
 *   mount: (scene: THREE.Scene) => void,
 *   update: (camera: THREE.Camera) => void,
 *   setOpacityTarget: (target: number) => void,
 *   dispose: () => void,
 * }}
 */
export function createNebulaBackground({ imageUrl, radius = 5000, widthSegments = 64, heightSegments = 32 } = {}) {
   if (!imageUrl) {
      throw new Error('createNebulaBackground: imageUrl is required');
   }

   const geometry = new THREE.SphereGeometry(radius, widthSegments, heightSegments);

   // The texture loader is async. We pre-set the mapping/colorSpace so
   // the texture is correct from the first frame the image decodes —
   // `loader.load(url, onLoad)` only fires the callback after decode,
   // but the texture object is returned immediately and is usable.
   //
   // Defensive: in non-browser environments (Node tests, SSR) `Image`
   // is undefined and the loader would throw. We fall back to a stub
   // texture so the rest of the module (geometry, material, mesh,
   // update, dispose) is still testable.
   let texture;
   try {
      const loader = new THREE.TextureLoader();
      texture = loader.load(
         imageUrl,
         (tex) => {
            // onLoad — called when the image has decoded. Nothing more to
            // do; mapping + colorSpace were set synchronously below.
            tex.needsUpdate = true;
         },
         undefined,
         (err) => {
            // Surface the error so it shows up in the dev console; the
            // background will be a solid color (the material's default).
            // The game still runs — the nebula is decorative.
            // eslint-disable-next-line no-console
            console.warn('[nebula-background] failed to load image:', imageUrl, err);
         },
      );
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.mapping = THREE.EquirectangularReflectionMapping;
   } catch (e) {
      // Non-browser environment or `Image` is undefined. Fall back to a
      // stub texture so the module is still usable (mesh + update +
      // dispose work; the background just shows a solid color).
      texture = new THREE.Texture();
      // eslint-disable-next-line no-console
      console.warn('[nebula-background] texture loader unavailable:', e && e.message);
   }

   const material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false, // keep the nebula visible through the scene fog
      transparent: true, // required for setOpacityTarget to fade
      opacity: 1.0,      // start fully opaque; updated by setOpacityTarget
   });

   const mesh = new THREE.Mesh(geometry, material);
   mesh.renderOrder = -1; // render first (behind everything else)
   mesh.frustumCulled = false; // the sphere is huge; never cull it
   mesh.name = 'nebula-background';

   let mountedScene = null;

   // Opacity target for the threshold-driven fade. The render loop
   // calls setOpacityTarget(0|1) based on whether the ship's current
   // chunk has a nebula (see src/main.js). The actual interpolation
   // happens in `update(camera, dt)` — we never snap, so the
   // transition is smooth. `null` means "not yet initialized" — the
   // first setOpacityTarget call seeds it.
   let opacityTarget = null;

   function mount(scene) {
      if (mountedScene === scene) return;
      if (mountedScene) mountedScene.remove(mesh);
      mountedScene = scene;
      if (scene) scene.add(mesh);
   }

   function update(camera, dt) {
      if (camera) mesh.position.copy(camera.position);
      // Smoothly approach the target opacity. The first call after
      // setOpacityTarget seeds the material's opacity directly so we
      // don't fade in from 0 on the first frame.
      if (opacityTarget != null) {
         if (material.opacity === opacityTarget) return;
         // Framerate-independent exponential damping. Time constant
         // `NEBULA_FADE_S` is the time to reach ~63% of the target;
         // a full fade takes ~3× the time constant.
         const TAU = 0.6; // matches NEBULA_FADE_S default
         const k = dt > 0 ? 1 - Math.exp(-dt / TAU) : 1;
         material.opacity += (opacityTarget - material.opacity) * k;
         if (Math.abs(material.opacity - opacityTarget) < 0.005) {
            material.opacity = opacityTarget; // snap to avoid endless tiny lerps
         }
      }
   }

   function setOpacityTarget(target) {
      if (typeof target !== 'number' || !Number.isFinite(target)) return;
      const clamped = Math.max(0, Math.min(1, target));
      if (opacityTarget == null) {
         // First call — seed the material's current opacity to the
         // target so the first frame doesn't show a fade-in from 0.
         material.opacity = clamped;
      }
      opacityTarget = clamped;
   }

   function dispose() {
      if (mountedScene) {
         mountedScene.remove(mesh);
         mountedScene = null;
      }
      geometry.dispose();
      material.dispose();
      if (texture.dispose) texture.dispose();
   }

   return { mesh, mount, update, setOpacityTarget, dispose };
}
