// Names floating over the lights in the 3D view. They're HTML, so they stay sharp at any distance.

import * as THREE from 'three';

const v = new THREE.Vector3();

// lights: [{ f: the fixture, at: [x, y, z] where its name goes }]
export function createLabels(root, lights, camera) {
  const tags = lights.map(({ f, at }) => {
    const el = document.createElement('span');
    el.className = 'tag';
    el.innerHTML = `<b>${f.id}</b> <span>${f.tag}</span>`;
    root.append(el);
    return { el, at: new THREE.Vector3(...at) };
  });
  return {
    update(w, h) {
      for (const tag of tags) {
        v.copy(tag.at).project(camera);
        const off = v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05;
        tag.el.hidden = off;
        if (!off) tag.el.style.transform = `translate3d(${Math.min(w - 16, Math.max(16, (v.x + 1) / 2 * w)).toFixed(1)}px,${((1 - v.y) / 2 * h).toFixed(1)}px,0) translate(-50%,-50%)`;
      }
    },
  };
}
