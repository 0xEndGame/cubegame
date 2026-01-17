// Game Configuration
const CONFIG = {
    GRID_X: 5,                 // 50x40x50 = 100,000 cubes
    GRID_Y: 4,
    GRID_Z: 5,
    CUBE_SIZE: 1,
    CUBE_SPACING: 1.02,         // Very slight gap for visual separation
    CUBE_COLOR: 0x4a90e2,
    CUBE_LOCKED_COLOR: 0x2a3f5f, // Darker color for locked layers
    CUBE_HOVER_COLOR: 0xff6b6b,
    REMOVE_ANIMATION_DURATION: 300,
    MIN_ZOOM: 40,
    MAX_ZOOM: 200,
    ZOOM_SPEED: 3,
    PAYMENT_RECIPIENT: '0x14740784D6b26181047bAF069cfd53B29E48E7C4', // Replace with your receiving address
    TRANSACTION_VALUE_ETH: 0.0001,
    WS_URL: 'wss://cubegame-production.up.railway.app', // Defaults to same origin; override for dev if needed
};

// Calculate total shell layers (like an onion)
// For dimension N, max depth is floor((N-1)/2), so layer count is that + 1
const MAX_LAYERS = Math.min(
    Math.floor((CONFIG.GRID_X - 1) / 2),
    Math.floor((CONFIG.GRID_Y - 1) / 2),
    Math.floor((CONFIG.GRID_Z - 1) / 2)
) + 1;

class CubeClickerGame {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.cubes = [];
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.hoveredCube = null;
        this.clickedCount = 0;
        this.animatingCubes = new Set();
        this.cameraDistance = 10;
        this.currentLayer = 0; // Start from outer shell (layer 0)

        // Wallet/payment state
        this.walletAddress = null;
        this.isProcessingPayment = false;
        this.walletStatusEl = document.getElementById('wallet-status');
        this.paymentStatusEl = document.getElementById('payment-status');
        this.activeClickersEl = document.getElementById('active-clickers');
        this.socket = null;
        this.pendingRemovalIds = new Set();

        // Camera rotation controls
        this.isDragging = false;
        this.dragMoved = false;
        this.previousMousePosition = { x: 0, y: 0 };
        this.cameraTheta = 0; // Horizontal angle
        this.cameraPhi = 1.0; // Vertical angle (radians from top)
        this.autoRotate = true;

        this.init();
        this.createCubeGrid();
        this.setupEventListeners();
        this.setupNetwork();
        this.updateWalletDisplay();
        this.updateLayerColors();
        this.animate();
        this.updateStats();
    }

    // Calculate which shell layer a cube belongs to (0 = outermost)
    getShellLayer(x, y, z) {
        const distX = Math.min(x, CONFIG.GRID_X - 1 - x);
        const distY = Math.min(y, CONFIG.GRID_Y - 1 - y);
        const distZ = Math.min(z, CONFIG.GRID_Z - 1 - z);
        return Math.min(distX, distY, distZ);
    }

    init() {
        // Scene setup
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1a1a2e);
        this.scene.fog = new THREE.Fog(0x1a1a2e, 100, 300);

        // Camera setup
        const aspect = window.innerWidth / window.innerHeight;
        this.camera = new THREE.PerspectiveCamera(75, aspect, 0.1, 500);

        // Renderer setup
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.shadowMap.enabled = true;
        document.getElementById('game-container').appendChild(this.renderer.domElement);

        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(10, 20, 10);
        directionalLight.castShadow = true;
        this.scene.add(directionalLight);

        const pointLight = new THREE.PointLight(0x667eea, 1, 100);
        pointLight.position.set(5, 10, 5);
        this.scene.add(pointLight);
    }

    createCubeGrid() {
        const geometry = new THREE.BoxGeometry(CONFIG.CUBE_SIZE, CONFIG.CUBE_SIZE, CONFIG.CUBE_SIZE);

        // Create a 3D cube formation (5x4x5 = 100 cubes)
        for (let x = 0; x < CONFIG.GRID_X; x++) {
            for (let y = 0; y < CONFIG.GRID_Y; y++) {
                for (let z = 0; z < CONFIG.GRID_Z; z++) {
                    const material = new THREE.MeshStandardMaterial({
                        color: CONFIG.CUBE_COLOR,
                        metalness: 0.3,
                        roughness: 0.4
                    });

                    const cube = new THREE.Mesh(geometry, material);
                    cube.position.set(
                        x * CONFIG.CUBE_SPACING,
                        y * CONFIG.CUBE_SPACING,
                        z * CONFIG.CUBE_SPACING
                    );
                    cube.castShadow = true;
                    cube.receiveShadow = true;

                    // Store shell layer and original position
                    cube.userData = {
                        originalColor: CONFIG.CUBE_COLOR,
                        id: `cube-${x}-${y}-${z}`,
                        gridX: x,
                        gridY: y,
                        gridZ: z,
                        shellLayer: this.getShellLayer(x, y, z),
                        originalPosY: y * CONFIG.CUBE_SPACING
                    };

                    this.scene.add(cube);
                    this.cubes.push(cube);
                }
            }
        }
    }

    setupEventListeners() {
        // Mouse move for hover effect and camera rotation
        window.addEventListener('mousemove', (event) => this.onMouseMove(event));

        // Mouse down for drag start
        window.addEventListener('mousedown', (event) => this.onMouseDown(event));

        // Mouse up for drag end and click
        window.addEventListener('mouseup', (event) => this.onMouseUp(event));

        // Scroll to zoom
        window.addEventListener('wheel', (event) => this.onMouseWheel(event), { passive: false });

        // Window resize
        window.addEventListener('resize', () => this.onWindowResize());

        // Reset button (optional)
        const resetBtn = document.getElementById('reset-btn');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => this.resetGame());
        }

        // Play again button
        document.getElementById('play-again-btn').addEventListener('click', () => this.resetGame());

        // Wallet connect button
        const connectBtn = document.getElementById('connect-wallet-btn');
        if (connectBtn) {
            connectBtn.addEventListener('click', () => this.connectWallet());
        }

        // Respond to wallet account changes
        if (window.ethereum && typeof window.ethereum.on === 'function') {
            window.ethereum.on('accountsChanged', (accounts) => {
                this.walletAddress = accounts && accounts.length ? accounts[0] : null;
                if (this.walletAddress) {
                    this.setWalletStatus(`Connected: ${this.shortenAddress(this.walletAddress)}`);
                } else {
                    this.setWalletStatus('Not connected');
                }
                this.updateActiveClickers();
            });
        }
    }

    onMouseDown(event) {
        if (event.button === 0) { // Left mouse button
            this.isDragging = true;
            this.dragMoved = false;
            this.previousMousePosition = { x: event.clientX, y: event.clientY };
            this.autoRotate = false;
        }
    }

    onMouseUp(event) {
        if (event.button === 0) {
            this.isDragging = false;

            // Only trigger click if we didn't drag
            if (!this.dragMoved) {
                this.handleCubeClick(event).catch((error) => {
                    console.error('Error handling cube click', error);
                    this.setPaymentStatus('Click failed');
                });
            }
        }
    }

    onMouseWheel(event) {
        event.preventDefault();

        // Adjust camera distance based on scroll direction
        this.cameraDistance += event.deltaY * 0.01 * CONFIG.ZOOM_SPEED;

        // Clamp to min/max zoom
        this.cameraDistance = Math.max(CONFIG.MIN_ZOOM, Math.min(CONFIG.MAX_ZOOM, this.cameraDistance));
    }

    isOnCurrentLayer(cube) {
        return cube.userData.shellLayer === this.currentLayer;
    }

    getClickableCubes() {
        return this.cubes.filter(cube =>
            cube.visible &&
            !this.animatingCubes.has(cube) &&
            this.isOnCurrentLayer(cube)
        );
    }

    updateWalletDisplay() {
        this.setWalletStatus('Not connected');
        this.updateActiveClickers(0);
    }

    setWalletStatus(text) {
        if (this.walletStatusEl) {
            this.walletStatusEl.textContent = text;
        }
    }

    updateActiveClickers(count) {
        if (!this.activeClickersEl) return;
        if (typeof count === 'number') {
            this.activeClickersEl.textContent = String(count);
        }
    }

    getWebSocketUrl() {
        if (CONFIG.WS_URL) return CONFIG.WS_URL;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}`;
    }

    setupNetwork() {
        try {
            const url = this.getWebSocketUrl();
            this.socket = new WebSocket(url);

            this.socket.addEventListener('open', () => {
                this.setPaymentStatus('Connected to server');
            });

            this.socket.addEventListener('message', (event) => this.handleSocketMessage(event));

            this.socket.addEventListener('close', () => {
                this.setPaymentStatus('Disconnected from server');
                if (this.activeClickersEl) this.activeClickersEl.textContent = '0';
                this.pendingRemovalIds.clear();
            });

            this.socket.addEventListener('error', () => {
                this.setPaymentStatus('Server connection error');
            });
        } catch (err) {
            console.error('WebSocket setup failed', err);
            this.setPaymentStatus('Server unavailable');
        }
    }

    handleSocketMessage(event) {
        try {
            const data = JSON.parse(event.data);
            switch (data.type) {
                case 'init':
                    this.applyServerState(data);
                    break;
                case 'cube_removed':
                    this.handleCubeRemovedFromServer(data);
                    break;
                case 'active':
                    this.updateActiveClickers(data.count || 0);
                    break;
                case 'error':
                    console.error('Server error:', data.message);
                    this.setPaymentStatus(data.message || 'Server error');
                    break;
                default:
                    console.warn('Unknown server message', data);
            }
        } catch (err) {
            console.error('Failed to parse server message', err);
        }
    }

    applyServerState(payload) {
        if (payload.cubes) {
            Object.entries(payload.cubes).forEach(([cubeId, visible]) => {
                const cube = this.cubes.find(c => c.userData.id === cubeId);
                if (cube) {
                    cube.visible = !!visible;
                    if (!cube.visible) {
                        cube.scale.set(0.001, 0.001, 0.001);
                    } else {
                        cube.scale.set(1, 1, 1);
                        cube.position.y = cube.userData.originalPosY;
                        cube.rotation.set(0, 0, 0);
                    }
                }
            });
        }
        if (typeof payload.clickedCount === 'number') {
            this.clickedCount = payload.clickedCount;
        }
        this.hideWinnerModal();
        this.syncLayerFromState();
        this.updateStats();
        this.checkWinner();
    }

    handleCubeRemovedFromServer(data) {
        const cubeId = data.id;
        const cube = this.cubes.find(c => c.userData.id === cubeId);
        if (!cube || !cube.visible) {
            this.pendingRemovalIds.delete(cubeId);
            return;
        }

        const clickedCount = typeof data.clickedCount === 'number' ? data.clickedCount : this.clickedCount;
        this.clickedCount = clickedCount;
        this.pendingRemovalIds.delete(cubeId);
        this.animateCubeRemoval(cube);
    }

    syncLayerFromState() {
        const visibleCubes = this.cubes.filter(c => c.visible);
        if (visibleCubes.length === 0) {
            this.currentLayer = 0;
            return;
        }
        this.currentLayer = Math.min(...visibleCubes.map(c => c.userData.shellLayer));
        this.updateLayerColors();
    }

    setPaymentStatus(text) {
        if (this.paymentStatusEl) {
            this.paymentStatusEl.textContent = text;
        }
    }

    shortenAddress(address) {
        if (!address) return '';
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    ethToWeiHex(amountEth) {
        const wei = BigInt(Math.round(amountEth * 1e18));
        return `0x${wei.toString(16)}`;
    }

    async connectWallet() {
        if (!window.ethereum) {
            this.setWalletStatus('No wallet detected');
            alert('An Ethereum-compatible wallet is required to play.');
            return null;
        }

        try {
            const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
            if (accounts && accounts.length > 0) {
                this.walletAddress = accounts[0];
                this.setWalletStatus(`Connected: ${this.shortenAddress(this.walletAddress)}`);
                this.updateActiveClickers();
                return this.walletAddress;
            }

            this.setWalletStatus('No accounts available');
            this.updateActiveClickers();
            return null;
        } catch (error) {
            this.setWalletStatus('Connection rejected');
            this.updateActiveClickers();
            console.error('Wallet connection rejected', error);
            return null;
        }
    }

    async executeCubePayment() {
        if (this.isProcessingPayment) {
            return false;
        }

        if (!window.ethereum) {
            this.setPaymentStatus('No wallet detected');
            alert('You need a wallet (e.g. MetaMask) to clear cubes.');
            return false;
        }

        const account = await this.connectWallet();
        if (!account) {
            return false;
        }

        const txParams = {
            from: account,
            to: CONFIG.PAYMENT_RECIPIENT,
            value: this.ethToWeiHex(CONFIG.TRANSACTION_VALUE_ETH),
        };

        this.isProcessingPayment = true;
        this.setPaymentStatus('Awaiting wallet confirmation...');

        try {
            const txHash = await window.ethereum.request({
                method: 'eth_sendTransaction',
                params: [txParams],
            });

            this.setPaymentStatus(`Sent: ${txHash.slice(0, 10)}...`);
            return true;
        } catch (error) {
            this.setPaymentStatus('Payment cancelled');
            console.error('Payment failed', error);
            return false;
        } finally {
            this.isProcessingPayment = false;
        }
    }

    requestCubeRemoval(cube) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            this.setPaymentStatus('Server not connected');
            return;
        }

        const cubeId = cube.userData.id;
        if (this.pendingRemovalIds.has(cubeId)) {
            return;
        }

        this.pendingRemovalIds.add(cubeId);
        const payload = {
            type: 'remove',
            id: cubeId,
            wallet: this.walletAddress || null,
        };
        this.socket.send(JSON.stringify(payload));
        this.setPaymentStatus('Awaiting server confirmation...');
    }

    updateLayerColors() {
        this.cubes.forEach(cube => {
            if (!cube.visible) return;

            if (this.isOnCurrentLayer(cube)) {
                cube.userData.originalColor = CONFIG.CUBE_COLOR;
                cube.material.color.setHex(CONFIG.CUBE_COLOR);
                cube.material.opacity = 1;
                cube.material.transparent = false;
            } else {
                cube.userData.originalColor = CONFIG.CUBE_LOCKED_COLOR;
                cube.material.color.setHex(CONFIG.CUBE_LOCKED_COLOR);
                cube.material.opacity = 0.6;
                cube.material.transparent = true;
            }
        });
    }

    checkLayerComplete() {
        // Check if current shell layer has any visible cubes left
        const layerCubes = this.cubes.filter(cube =>
            cube.visible && cube.userData.shellLayer === this.currentLayer
        );

        if (layerCubes.length === 0 && this.currentLayer < MAX_LAYERS - 1) {
            // Move to next inner layer
            this.currentLayer++;
            this.updateLayerColors();
        }
    }

    onMouseMove(event) {
        // Calculate mouse position in normalized device coordinates
        this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

        // Handle camera rotation when dragging
        if (this.isDragging) {
            const deltaX = event.clientX - this.previousMousePosition.x;
            const deltaY = event.clientY - this.previousMousePosition.y;

            // Mark as moved if drag distance exceeds threshold
            if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
                this.dragMoved = true;
            }

            // Update camera angles
            this.cameraTheta -= deltaX * 0.01;
            this.cameraPhi += deltaY * 0.01;

            // Clamp vertical angle to prevent flipping
            this.cameraPhi = Math.max(0.1, Math.min(Math.PI - 0.1, this.cameraPhi));

            this.previousMousePosition = { x: event.clientX, y: event.clientY };
            return; // Don't update hover while dragging
        }

        // Update raycaster
        this.raycaster.setFromCamera(this.mouse, this.camera);

        // Get intersections with clickable cubes only (current layer)
        const clickableCubes = this.getClickableCubes();
        const intersects = this.raycaster.intersectObjects(clickableCubes);

        // Reset previously hovered cube
        if (this.hoveredCube) {
            this.hoveredCube.material.color.setHex(this.hoveredCube.userData.originalColor);
            this.hoveredCube.scale.set(1, 1, 1);
            this.hoveredCube = null;
        }

        // Highlight hovered cube (only if on current layer)
        if (intersects.length > 0) {
            this.hoveredCube = intersects[0].object;
            this.hoveredCube.material.color.setHex(CONFIG.CUBE_HOVER_COLOR);
            this.hoveredCube.scale.set(1.1, 1.1, 1.1);
        }
    }

    async handleCubeClick(event) {
        // Prevent clicking UI elements
        if (event.target.tagName === 'BUTTON') return;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const clickableCubes = this.getClickableCubes();
        const intersects = this.raycaster.intersectObjects(clickableCubes);

        if (intersects.length > 0) {
            const cube = intersects[0].object;
            const paid = await this.executeCubePayment();
            if (paid) {
                this.requestCubeRemoval(cube);
            }
        }
    }

    animateCubeRemoval(cube) {
        if (this.animatingCubes.has(cube)) return;

        this.animatingCubes.add(cube);

        // Animate cube removal
        const startTime = Date.now();
        const startScale = { x: cube.scale.x, y: cube.scale.y, z: cube.scale.z };
        const startY = cube.position.y;

        const animateRemoval = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / CONFIG.REMOVE_ANIMATION_DURATION, 1);

            // Ease out cubic
            const easeProgress = 1 - Math.pow(1 - progress, 3);

            // Scale down and move up
            cube.scale.set(
                startScale.x * (1 - easeProgress),
                startScale.y * (1 - easeProgress),
                startScale.z * (1 - easeProgress)
            );
            cube.position.y = startY + easeProgress * 3;
            cube.rotation.x += 0.1;
            cube.rotation.y += 0.1;

            if (progress < 1) {
                requestAnimationFrame(animateRemoval);
            } else {
                cube.visible = false;
                this.animatingCubes.delete(cube);
                this.updateStats();
                this.syncLayerFromState();
                this.checkWinner();
            }
        };

        animateRemoval();
    }

    updateStats() {
        const remaining = this.cubes.filter(cube => cube.visible).length;
        document.getElementById('cube-count').textContent = remaining;
        document.getElementById('clicked-count').textContent = this.clickedCount;
        document.getElementById('layer-count').textContent = this.currentLayer + 1;
        document.getElementById('total-layers').textContent = MAX_LAYERS;
    }

    checkWinner() {
        const remaining = this.cubes.filter(cube => cube.visible).length;
        if (remaining === 0) {
            this.showWinnerModal();
        }
    }

    showWinnerModal() {
        document.getElementById('final-count').textContent = this.clickedCount;
        document.getElementById('winner-modal').classList.remove('hidden');
    }

    hideWinnerModal() {
        document.getElementById('winner-modal').classList.add('hidden');
    }

    resetGame() {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type: 'reset' }));
            this.setPaymentStatus('Reset requested...');
            return;
        }
        this.applyLocalReset();
    }

    applyLocalReset() {
        this.hideWinnerModal();
        this.clickedCount = 0;
        this.animatingCubes.clear();
        this.currentLayer = 0; // Reset to outer shell

        this.cubes.forEach(cube => {
            cube.visible = true;
            cube.scale.set(1, 1, 1);
            cube.position.y = cube.userData.originalPosY;
            cube.rotation.set(0, 0, 0);
        });

        this.updateLayerColors();
        this.updateStats();
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        const centerX = (CONFIG.GRID_X * CONFIG.CUBE_SPACING) / 2;
        const centerY = (CONFIG.GRID_Y * CONFIG.CUBE_SPACING) / 2;
        const centerZ = (CONFIG.GRID_Z * CONFIG.CUBE_SPACING) / 2;

        // Auto-rotate slowly when not dragging
        if (this.autoRotate) {
            this.cameraTheta += 0.002;
        }

        // Calculate camera position using spherical coordinates
        this.camera.position.x = centerX + Math.sin(this.cameraTheta) * Math.sin(this.cameraPhi) * this.cameraDistance;
        this.camera.position.y = centerY + Math.cos(this.cameraPhi) * this.cameraDistance;
        this.camera.position.z = centerZ + Math.cos(this.cameraTheta) * Math.sin(this.cameraPhi) * this.cameraDistance;
        this.camera.lookAt(centerX, centerY, centerZ);

        this.renderer.render(this.scene, this.camera);
    }
}

// Start the game when page loads
window.addEventListener('DOMContentLoaded', () => {
    new CubeClickerGame();
});
