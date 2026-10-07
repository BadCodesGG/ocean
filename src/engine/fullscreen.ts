import * as THREE from "three";

/** One triangle that covers the viewport, shared by every full-screen pass. */
export const fullscreenTriangle = new THREE.BufferGeometry();
fullscreenTriangle.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
