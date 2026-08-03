// Keep the game-facing Three namespace deliberately narrow and bypass Three's
// package barrel so Rollup can split its source graph without a chunk cycle.
export {
  ACESFilmicToneMapping,
  BackSide,
  DoubleSide,
  PCFShadowMap,
  PCFSoftShadowMap,
  RepeatWrapping,
  SRGBColorSpace,
} from "three/src/constants.js";

export { Box3 } from "three/src/math/Box3.js";
export { Color } from "three/src/math/Color.js";
export { Euler } from "three/src/math/Euler.js";
export { MathUtils } from "three/src/math/MathUtils.js";
export { Matrix4 } from "three/src/math/Matrix4.js";
export { Plane } from "three/src/math/Plane.js";
export { Quaternion } from "three/src/math/Quaternion.js";
export { Vector2 } from "three/src/math/Vector2.js";
export { Vector3 } from "three/src/math/Vector3.js";
export { Vector4 } from "three/src/math/Vector4.js";

export { BufferAttribute, Float32BufferAttribute } from "three/src/core/BufferAttribute.js";
export { BufferGeometry } from "three/src/core/BufferGeometry.js";
export { Clock } from "three/src/core/Clock.js";
export { Object3D } from "three/src/core/Object3D.js";
export { Raycaster } from "three/src/core/Raycaster.js";

export { CanvasTexture } from "three/src/textures/CanvasTexture.js";
export { Texture } from "three/src/textures/Texture.js";

export { BoxGeometry } from "three/src/geometries/BoxGeometry.js";
export { CylinderGeometry } from "three/src/geometries/CylinderGeometry.js";
export { PlaneGeometry } from "three/src/geometries/PlaneGeometry.js";
export { RingGeometry } from "three/src/geometries/RingGeometry.js";
export { SphereGeometry } from "three/src/geometries/SphereGeometry.js";
export { TorusGeometry } from "three/src/geometries/TorusGeometry.js";

export { Material } from "three/src/materials/Material.js";
export { LineBasicMaterial } from "three/src/materials/LineBasicMaterial.js";
export { MeshBasicMaterial } from "three/src/materials/MeshBasicMaterial.js";
export { MeshStandardMaterial } from "three/src/materials/MeshStandardMaterial.js";
export { ShaderMaterial } from "three/src/materials/ShaderMaterial.js";
export { SpriteMaterial } from "three/src/materials/SpriteMaterial.js";

export { Group } from "three/src/objects/Group.js";
export { InstancedMesh } from "three/src/objects/InstancedMesh.js";
export { Line } from "three/src/objects/Line.js";
export { LineSegments } from "three/src/objects/LineSegments.js";
export { Mesh } from "three/src/objects/Mesh.js";
export { Sprite } from "three/src/objects/Sprite.js";

export { AmbientLight } from "three/src/lights/AmbientLight.js";
export { DirectionalLight } from "three/src/lights/DirectionalLight.js";
export { HemisphereLight } from "three/src/lights/HemisphereLight.js";

export { PerspectiveCamera } from "three/src/cameras/PerspectiveCamera.js";
export { Fog } from "three/src/scenes/Fog.js";
export { Scene } from "three/src/scenes/Scene.js";
export { Box3Helper } from "three/src/helpers/Box3Helper.js";
export { GridHelper } from "three/src/helpers/GridHelper.js";
export { WebGLRenderer } from "three/src/renderers/WebGLRenderer.js";
