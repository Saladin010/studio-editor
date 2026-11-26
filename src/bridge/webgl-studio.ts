import {
    Asset,
    BoundingBox,
    Color,
    Entity,
    type GraphicsDevice,
    Vec3
} from 'playcanvas';

import { PCApp } from '../pc-app';

import {
    computeEntityMeshBound,
    extractModelFilename,
    isGlbUrl,
    loadGlbEntityOnApp,
    raycastCameraAgainstEntities
} from './glb-model';
import {
    type CropBoxBounds,
    notifyParent,
    registerStudioBridgeListener,
    type SpawnPose,
    type StudioBridgeAPI
} from './studio-bridge';

const GRID_COLOR = new Color(0.24, 0.3, 0.4, 1);
const CROP_BOX_COLOR = new Color(0.06, 0.73, 0.51, 1);

const drawGrid = (app: PCApp, halfExtent = 10, step = 1) => {
    const positions: Vec3[] = [];
    const colors: Color[] = [];
    for (let i = -halfExtent; i <= halfExtent; i += step) {
        positions.push(new Vec3(i, 0, -halfExtent), new Vec3(i, 0, halfExtent));
        colors.push(GRID_COLOR, GRID_COLOR);
        positions.push(new Vec3(-halfExtent, 0, i), new Vec3(halfExtent, 0, i));
        colors.push(GRID_COLOR, GRID_COLOR);
    }
    app.drawLines(positions, colors, true);
};

const drawCropBox = (app: PCApp, bounds: CropBoxBounds) => {
    const [minX, maxX, minY, maxY, minZ, maxZ] = bounds;
    const c = [
        new Vec3(minX, minY, minZ),
        new Vec3(maxX, minY, minZ),
        new Vec3(maxX, minY, maxZ),
        new Vec3(minX, minY, maxZ),
        new Vec3(minX, maxY, minZ),
        new Vec3(maxX, maxY, minZ),
        new Vec3(maxX, maxY, maxZ),
        new Vec3(minX, maxY, maxZ)
    ];
    const edges: [number, number][] = [
        [0, 1], [1, 2], [2, 3], [3, 0],
        [4, 5], [5, 6], [6, 7], [7, 4],
        [0, 4], [1, 5], [2, 6], [3, 7]
    ];
    const positions: Vec3[] = [];
    const colors: Color[] = [];
    for (const [a, b] of edges) {
        positions.push(c[a], c[b]);
        colors.push(CROP_BOX_COLOR, CROP_BOX_COLOR);
    }
    app.drawLines(positions, colors, true);
};

export const startWebglGlbStudio = async (
    canvas: HTMLCanvasElement,
    graphicsDevice: GraphicsDevice,
    urlParams: URLSearchParams
): Promise<void> => {
    canvas.id = 'canvas';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';

    const app = new PCApp(canvas, { graphicsDevice });
    const texHandler = app.loader.getHandler('texture') as unknown as { imgParser?: { crossOrigin?: string } } | null;
    if (texHandler?.imgParser) {
        texHandler.imgParser.crossOrigin = 'anonymous';
    }
    app.graphicsDevice.maxPixelRatio = window.devicePixelRatio || 1;

    const resizeToParent = () => {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));
        graphicsDevice.resizeCanvas(w, h);
    };
    const ro = new ResizeObserver(resizeToParent);
    ro.observe(canvas);
    window.addEventListener('resize', resizeToParent);

    const worldLayer = app.scene.layers.getLayerByName('World');
    const cameraEntity = new Entity('studioCamera', app);
    cameraEntity.addComponent('camera', {
        clearColor: new Color(0.08, 0.11, 0.16, 1),
        fov: 50,
        nearClip: 0.05,
        farClip: 500,
        layers: worldLayer ? [worldLayer.id] : undefined
    });
    app.root.addChild(cameraEntity);

    // Subtle HUD badge
    const badge = document.createElement('div');
    badge.style.cssText = [
        'position:fixed',
        'top:10px',
        'left:10px',
        'z-index:20',
        'padding:6px 10px',
        'border-radius:6px',
        'background:rgba(15,23,42,0.82)',
        'border:1px solid rgba(56,189,248,0.35)',
        'color:#e2e8f0',
        'font-family:system-ui,sans-serif',
        'font-size:12px',
        'pointer-events:none'
    ].join(';');
    badge.textContent = 'WebGL2 3D Mesh Studio (.glb) | Drag: Orbit | Right/Shift+Drag: Pan | Wheel: Zoom | WASD: Move';
    document.body.appendChild(badge);

    // Orbit + Pan + WASD camera state
    const focalPoint = new Vec3(0, 1, 0);
    let azimDeg = 35;
    let elevDeg = -20;
    let distance = 6;
    const pressedKeys = new Set<string>();

    const updateCameraTransform = () => {
        const az = (azimDeg * Math.PI) / 180;
        const el = (elevDeg * Math.PI) / 180;
        const cosEl = Math.cos(el);
        const cx = focalPoint.x + distance * cosEl * Math.sin(az);
        const cy = focalPoint.y - distance * Math.sin(el);
        const cz = focalPoint.z + distance * cosEl * Math.cos(az);
        cameraEntity.setPosition(cx, cy, cz);
        cameraEntity.lookAt(focalPoint);
    };
    updateCameraTransform();

    // Pointer state
    let isDragging = false;
    let dragMode: 'orbit' | 'pan' = 'orbit';
    let lastX = 0;
    let lastY = 0;
    let isPickingActive = false;
    let currentPickCallback: ((coords: [number, number, number]) => void) | null = null;

    let currentAsset: Asset | null = null;
    let currentEntity: Entity | null = null;
    const currentBound = new BoundingBox();
    let currentCropBounds: CropBoxBounds = [-5, 5, -2, 4, -5, 5];
    let currentFloorTilt = 0;

    const disableSplatPick = () => {
        isPickingActive = false;
        currentPickCallback = null;
        canvas.style.cursor = '';
    };

    const enableSplatPick = (callback?: (coords: [number, number, number]) => void) => {
        isPickingActive = true;
        currentPickCallback = callback || null;
        canvas.style.cursor = 'crosshair';
    };

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
        if (isPickingActive && e.button === 0) {
            const rect = canvas.getBoundingClientRect();
            const cam = cameraEntity.camera;
            let coords: [number, number, number] | null = null;

            if (cam && currentEntity) {
                const hit = raycastCameraAgainstEntities(cam, [currentEntity], e.clientX, e.clientY, rect);
                if (hit) {
                    coords = [Number(hit.x.toFixed(3)), Number(hit.y.toFixed(3)), Number(hit.z.toFixed(3))];
                }
            }

            if (!coords) {
                coords = [
                    Number(focalPoint.x.toFixed(3)),
                    Number(focalPoint.y.toFixed(3)),
                    Number(focalPoint.z.toFixed(3))
                ];
            }

            currentPickCallback?.(coords);
            notifyParent({ type: 'studio:splatPicked', coords });
            disableSplatPick();
            return;
        }

        isDragging = true;
        dragMode = e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : 'orbit';
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.setPointerCapture?.(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e: PointerEvent) => {
        if (!isDragging) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;

        if (dragMode === 'orbit') {
            azimDeg -= dx * 0.35;
            elevDeg = Math.max(-88, Math.min(88, elevDeg - dy * 0.35));
        } else {
            const panSpeed = Math.max(0.002, distance * 0.0018);
            const right = cameraEntity.right;
            const up = cameraEntity.up;
            focalPoint.addScaled(right, -dx * panSpeed);
            focalPoint.addScaled(up, dy * panSpeed);
        }
        updateCameraTransform();
    });

    const endDrag = (e: PointerEvent) => {
        isDragging = false;
        if (canvas.hasPointerCapture?.(e.pointerId)) {
            canvas.releasePointerCapture(e.pointerId);
        }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener(
        'wheel',
        (e: WheelEvent) => {
            e.preventDefault();
            const factor = e.deltaY > 0 ? 1.12 : 0.89;
            distance = Math.max(0.25, Math.min(120, distance * factor));
            updateCameraTransform();
        },
        { passive: false }
    );

    window.addEventListener('keydown', (e) => pressedKeys.add(e.code));
    window.addEventListener('keyup', (e) => pressedKeys.delete(e.code));

    app.on('update', (dt: number) => {
        if (pressedKeys.size > 0) {
            const moveSpeed = Math.max(1.5, distance * 0.6) * dt;
            const forward = cameraEntity.forward;
            const right = cameraEntity.right;
            let moved = false;
            if (pressedKeys.has('KeyW') || pressedKeys.has('ArrowUp')) {
                focalPoint.addScaled(forward, moveSpeed);
                moved = true;
            }
            if (pressedKeys.has('KeyS') || pressedKeys.has('ArrowDown')) {
                focalPoint.addScaled(forward, -moveSpeed);
                moved = true;
            }
            if (pressedKeys.has('KeyD') || pressedKeys.has('ArrowRight')) {
                focalPoint.addScaled(right, moveSpeed);
                moved = true;
            }
            if (pressedKeys.has('KeyA') || pressedKeys.has('ArrowLeft')) {
                focalPoint.addScaled(right, -moveSpeed);
                moved = true;
            }
            if (pressedKeys.has('KeyE')) {
                focalPoint.y += moveSpeed;
                moved = true;
            }
            if (pressedKeys.has('KeyQ')) {
                focalPoint.y -= moveSpeed;
                moved = true;
            }
            if (moved) updateCameraTransform();
        }

        drawGrid(app);
        drawCropBox(app, currentCropBounds);
    });

    const clearCurrentModel = () => {
        if (currentEntity) {
            currentEntity.destroy();
            currentEntity = null;
        }
        if (currentAsset) {
            app.assets.remove(currentAsset);
            currentAsset.unload();
            currentAsset = null;
        }
    };

    const bridge: StudioBridgeAPI = {
        loadSog: async (signedModelUrl: string): Promise<boolean> => {
            if (!signedModelUrl) {
                throw new Error('signedModelUrl is required');
            }
            if (!isGlbUrl(signedModelUrl)) {
                throw new Error('WebGPU is required for .sog/.ply files. This WebGL2 Studio supports .glb meshes.');
            }

            badge.textContent = 'Loading .glb mesh...';
            clearCurrentModel();

            const filename = extractModelFilename(signedModelUrl, 'scene.glb');
            const { asset, entity } = await loadGlbEntityOnApp(app, signedModelUrl, filename);
            currentAsset = asset;
            currentEntity = entity;
            app.root.addChild(entity);

            if (currentFloorTilt !== 0) {
                entity.setLocalEulerAngles(currentFloorTilt, 0, 0);
            }

            if (computeEntityMeshBound(entity, currentBound)) {
                focalPoint.copy(currentBound.center);
                distance = Math.max(1.5, Math.min(50, currentBound.halfExtents.length() * 1.6));
                updateCameraTransform();
            }

            badge.textContent = `WebGL2 3D Mesh Studio (${filename}) | Drag: Orbit | Right/Shift+Drag: Pan | Wheel: Zoom`;
            return true;
        },

        getCropBox: (): CropBoxBounds => [...currentCropBounds],

        setCropBox: (bounds: CropBoxBounds) => {
            currentCropBounds = [...bounds];
            notifyParent({
                type: 'studio:cropBoxChanged',
                bounds: currentCropBounds
            });
        },

        getFloorTilt: (): number => currentFloorTilt,

        setFloorTilt: (degrees: number) => {
            currentFloorTilt = degrees;
            if (currentEntity) {
                const cur = currentEntity.getLocalEulerAngles();
                currentEntity.setLocalEulerAngles(degrees, cur.y, cur.z);
            }
            notifyParent({
                type: 'studio:floorTiltChanged',
                degrees: currentFloorTilt
            });
        },

        calibrateDoorScale: (doorHeightMeters = 2.1): { scaleFactor: number; currentScale: number } => {
            if (!currentEntity) {
                return { scaleFactor: 1, currentScale: 1 };
            }
            computeEntityMeshBound(currentEntity, currentBound);
            let measuredHeight = currentBound.halfExtents.y * 2 * 0.75;
            if (measuredHeight <= 0.01) measuredHeight = 2.1;

            const scaleFactor = doorHeightMeters / measuredHeight;
            const curScale = currentEntity.getLocalScale();
            const nextScale = curScale.x * scaleFactor;
            currentEntity.setLocalScale(nextScale, curScale.y * scaleFactor, curScale.z * scaleFactor);

            if (computeEntityMeshBound(currentEntity, currentBound)) {
                focalPoint.copy(currentBound.center);
                distance = Math.max(1.5, Math.min(50, currentBound.halfExtents.length() * 1.6));
                updateCameraTransform();
            }

            return { scaleFactor, currentScale: nextScale };
        },

        captureSpawnPose: (): SpawnPose => {
            const pos = cameraEntity.getPosition();
            const rawMatrix = cameraEntity.getWorldTransform()?.data;
            const matrix: number[] = rawMatrix ? Array.from(rawMatrix) : [];
            const fov = cameraEntity.camera?.fov ?? 50;
            const pose = [
                Number(pos.x.toFixed(4)),
                Number(pos.y.toFixed(4)),
                Number(pos.z.toFixed(4)),
                Number(focalPoint.x.toFixed(4)),
                Number(focalPoint.y.toFixed(4)),
                Number(focalPoint.z.toFixed(4)),
                Number(fov.toFixed(2))
            ];

            const spawnPose: SpawnPose = {
                position: [pos.x, pos.y, pos.z],
                target: [focalPoint.x, focalPoint.y, focalPoint.z],
                matrix,
                fov,
                pose
            };

            notifyParent({
                type: 'studio:spawnPoseCaptured',
                pose: spawnPose
            });

            return spawnPose;
        },

        enableSplatPick,
        disableSplatPick
    };

    registerStudioBridgeListener(bridge);
    app.start();
    resizeToParent();

    const loadList = urlParams.getAll('load');
    if (loadList.length > 0) {
        await bridge.loadSog(decodeURIComponent(loadList[0]));
    }
};
