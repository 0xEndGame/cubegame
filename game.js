// Game Configuration
const CONFIG = {
    GRID_X: 50,                 // 50x40x50 = 100,000 cubes
    GRID_Y: 40,
    GRID_Z: 50,
    CUBE_SIZE: 1,
    CUBE_SPACING: 1.02,
    CUBE_COLOR: 0x4a90e2,
    CUBE_LOCKED_COLOR: 0x2a3f5f,
    CUBE_HOVER_COLOR: 0xff6b6b,
    HOLE_COLOR: 0xff9f43,
    REMOVE_ANIMATION_DURATION: 300,
    MIN_ZOOM: 80,
    MAX_ZOOM: 400,
    ZOOM_SPEED: 3,

    // Solana Configuration
    SOLANA_NETWORK: 'devnet', // 'devnet', 'testnet', or 'mainnet-beta'
    PROGRAM_ID: 'CubeGameXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', // Replace after deployment
    TREASURY_WALLET: '8hMXDgqF8EWtE4ngb4dWqFT6jyLK9YW3Fq6HL9bFm2pS', // <-- PUT YOUR WALLET ADDRESS HERE
    PRICE_PER_CUBE_SOL: 0.001, // 0.001 SOL per cube
};

// Solana RPC endpoints
const SOLANA_RPC = {
    'devnet': 'https://api.devnet.solana.com',
    'testnet': 'https://api.testnet.solana.com',
    'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};

// Calculate total shell layers (like an onion)
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
        this.cubeData = [];
        this.cubeLookup = new Map();
        this.holeMarkers = new Map();
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.hoveredCube = null;
        this.clickedCount = 0;
        this.myClickedCount = 0; // Personal counter
        this.animatingCubes = new Set();
        this.cameraDistance = 160;
        this.currentLayer = 0;

        // Solana state
        this.connection = null;
        this.walletPublicKey = null;
        this.isProcessingPayment = false;
        this.removedCubesCache = new Set(); // Cache of removed cube IDs

        // UI elements
        this.walletStatusEl = document.getElementById('wallet-status');
        this.paymentStatusEl = document.getElementById('payment-status');
        this.connectBtn = document.getElementById('connect-wallet-btn');
        this.myClickedEl = document.getElementById('my-clicked-count');

        // Camera rotation controls
        this.isDragging = false;
        this.dragMoved = false;
        this.previousMousePosition = { x: 0, y: 0 };
        this.cameraTheta = 0;
        this.cameraPhi = 1.0;
        this.autoRotate = true;

        this.init();
        this.createCubeData();
        this.loadCurrentLayerMeshes();
        this.setupEventListeners();
        this.initSolana();
        this.updateWalletDisplay();
        this.updateLayerColors();
        this.animate();
        this.updateStats();
    }

    // Initialize Solana connection
    async initSolana() {
        try {
            const rpcUrl = SOLANA_RPC[CONFIG.SOLANA_NETWORK];
            this.connection = new solanaWeb3.Connection(rpcUrl, 'confirmed');
            this.setPaymentStatus(`Connected to Solana ${CONFIG.SOLANA_NETWORK}`);

            // Try to reconnect if wallet was previously connected
            if (window.solana?.isPhantom && window.solana.isConnected) {
                await this.connectWallet();
            }

            // Load removed cubes from chain (in batches for performance)
            await this.syncRemovedCubesFromChain();
        } catch (error) {
            console.error('Solana init error:', error);
            this.setPaymentStatus('Failed to connect to Solana');
        }
    }

    // Sync removed cubes from blockchain
    async syncRemovedCubesFromChain() {
        // For a full implementation, you'd query the program's accounts
        // For now, we'll use localStorage as a fallback cache
        try {
            const cached = localStorage.getItem('removedCubes');
            if (cached) {
                const removed = JSON.parse(cached);
                removed.forEach(id => {
                    this.removedCubesCache.add(id);
                    const data = this.cubeLookup.get(id);
                    if (data) data.visible = false;
                });
                this.clickedCount = removed.length;
                this.syncLayerFromState();
                this.loadCurrentLayerMeshes();
                this.updateStats();
            }
        } catch (e) {
            console.warn('Could not load cached state:', e);
        }
    }

    // Save removed cubes to localStorage (backup)
    saveRemovedCubes() {
        try {
            localStorage.setItem('removedCubes', JSON.stringify([...this.removedCubesCache]));
        } catch (e) {
            console.warn('Could not save state:', e);
        }
    }

    getShellLayer(x, y, z) {
        const distX = Math.min(x, CONFIG.GRID_X - 1 - x);
        const distY = Math.min(y, CONFIG.GRID_Y - 1 - y);
        const distZ = Math.min(z, CONFIG.GRID_Z - 1 - z);
        return Math.min(distX, distY, distZ);
    }

    init() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1a1a2e);
        this.scene.fog = new THREE.Fog(0x1a1a2e, 100, 300);

        const aspect = window.innerWidth / window.innerHeight;
        this.camera = new THREE.PerspectiveCamera(75, aspect, 0.1, 500);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.shadowMap.enabled = true;
        document.getElementById('game-container').appendChild(this.renderer.domElement);

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

    createCubeData() {
        this.cubeData = [];
        this.cubeLookup.clear();
        for (let x = 0; x < CONFIG.GRID_X; x++) {
            for (let y = 0; y < CONFIG.GRID_Y; y++) {
                for (let z = 0; z < CONFIG.GRID_Z; z++) {
                    const data = {
                        id: `cube-${x}-${y}-${z}`,
                        gridX: x,
                        gridY: y,
                        gridZ: z,
                        shellLayer: this.getShellLayer(x, y, z),
                        originalPosY: y * CONFIG.CUBE_SPACING,
                        visible: true,
                    };
                    this.cubeData.push(data);
                    this.cubeLookup.set(data.id, data);
                }
            }
        }
    }

    clearCurrentLayerMeshes() {
        this.cubes.forEach(mesh => {
            this.scene.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
        });
        this.cubes = [];
        this.hoveredCube = null;

        this.holeMarkers.forEach(marker => {
            this.scene.remove(marker);
            marker.geometry.dispose();
            marker.material.dispose();
        });
        this.holeMarkers.clear();
    }

    loadCurrentLayerMeshes() {
        this.clearCurrentLayerMeshes();
        const sharedGeometry = new THREE.BoxGeometry(CONFIG.CUBE_SIZE, CONFIG.CUBE_SIZE, CONFIG.CUBE_SIZE);

        this.cubeData.forEach(data => {
            if (data.shellLayer !== this.currentLayer) return;

            if (data.visible) {
                const material = new THREE.MeshStandardMaterial({
                    color: CONFIG.CUBE_COLOR,
                    metalness: 0.3,
                    roughness: 0.4,
                    opacity: 1,
                    transparent: false,
                });

                const cube = new THREE.Mesh(sharedGeometry.clone(), material);
                cube.position.set(
                    data.gridX * CONFIG.CUBE_SPACING,
                    data.gridY * CONFIG.CUBE_SPACING,
                    data.gridZ * CONFIG.CUBE_SPACING
                );
                cube.castShadow = true;
                cube.receiveShadow = true;

                cube.userData = {
                    originalColor: CONFIG.CUBE_COLOR,
                    id: data.id,
                    shellLayer: data.shellLayer,
                    originalPosY: data.originalPosY,
                    dataRef: data,
                };

                this.scene.add(cube);
                this.cubes.push(cube);
            } else {
                this.addHoleMarker(data);
            }
        });

        this.updateLayerColors();
    }

    setupEventListeners() {
        window.addEventListener('mousemove', (event) => this.onMouseMove(event));
        window.addEventListener('mousedown', (event) => this.onMouseDown(event));
        window.addEventListener('mouseup', (event) => this.onMouseUp(event));
        window.addEventListener('wheel', (event) => this.onMouseWheel(event), { passive: false });
        window.addEventListener('resize', () => this.onWindowResize());

        document.getElementById('play-again-btn')?.addEventListener('click', () => this.resetGame());

        if (this.connectBtn) {
            this.connectBtn.addEventListener('click', () => this.handleConnectButton());
        }

        // Listen for Phantom wallet changes
        if (window.solana) {
            window.solana.on('connect', () => {
                this.walletPublicKey = window.solana.publicKey;
                this.setWalletStatus(`Connected: ${this.shortenAddress(this.walletPublicKey.toString())}`);
                this.updateConnectButton();
            });

            window.solana.on('disconnect', () => {
                this.walletPublicKey = null;
                this.setWalletStatus('Not connected');
                this.updateConnectButton();
            });
        }
    }

    onMouseDown(event) {
        if (event.button === 0) {
            this.isDragging = true;
            this.dragMoved = false;
            this.previousMousePosition = { x: event.clientX, y: event.clientY };
            this.autoRotate = false;
        }
    }

    onMouseUp(event) {
        if (event.button === 0) {
            this.isDragging = false;
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
        this.cameraDistance += event.deltaY * 0.01 * CONFIG.ZOOM_SPEED;
        this.cameraDistance = Math.max(CONFIG.MIN_ZOOM, Math.min(CONFIG.MAX_ZOOM, this.cameraDistance));
    }

    getClickableCubes() {
        return this.cubes.filter(cube => cube.visible && !this.animatingCubes.has(cube));
    }

    updateWalletDisplay() {
        this.setWalletStatus('Not connected');
        this.updateConnectButton();
    }

    setWalletStatus(text) {
        if (this.walletStatusEl) {
            this.walletStatusEl.textContent = text;
        }
    }

    setPaymentStatus(text) {
        if (this.paymentStatusEl) {
            this.paymentStatusEl.textContent = text;
        }
    }

    updateConnectButton() {
        if (!this.connectBtn) return;
        this.connectBtn.textContent = this.walletPublicKey ? 'Disconnect Wallet' : 'Connect Phantom';
    }

    shortenAddress(address) {
        if (!address) return '';
        return `${address.slice(0, 4)}...${address.slice(-4)}`;
    }

    async connectWallet() {
        if (!window.solana?.isPhantom) {
            this.setWalletStatus('Phantom not found');
            alert('Please install Phantom wallet to play!\nhttps://phantom.app');
            return null;
        }

        try {
            const response = await window.solana.connect();
            this.walletPublicKey = response.publicKey;
            this.setWalletStatus(`Connected: ${this.shortenAddress(this.walletPublicKey.toString())}`);
            this.updateConnectButton();
            return this.walletPublicKey;
        } catch (error) {
            this.setWalletStatus('Connection rejected');
            console.error('Wallet connection rejected', error);
            return null;
        }
    }

    async disconnectWallet() {
        if (window.solana) {
            await window.solana.disconnect();
        }
        this.walletPublicKey = null;
        this.setWalletStatus('Not connected');
        this.setPaymentStatus('Disconnected');
        this.updateConnectButton();
    }

    async handleConnectButton() {
        if (this.walletPublicKey) {
            await this.disconnectWallet();
        } else {
            await this.connectWallet();
        }
    }

    // Execute Solana payment and remove cube
    async removeCubeWithPayment(cube) {
        if (this.isProcessingPayment) {
            this.setPaymentStatus('Transaction in progress...');
            return false;
        }

        if (!window.solana?.isPhantom) {
            this.setPaymentStatus('Phantom wallet required');
            alert('Please install Phantom wallet to play!\nhttps://phantom.app');
            return false;
        }

        // Connect wallet if needed
        if (!this.walletPublicKey) {
            const connected = await this.connectWallet();
            if (!connected) return false;
        }

        const cubeId = cube.userData.id;

        // Check if already removed
        if (this.removedCubesCache.has(cubeId)) {
            this.setPaymentStatus('Cube already removed');
            return false;
        }

        this.isProcessingPayment = true;
        this.setPaymentStatus('Creating transaction...');

        try {
            // Create a simple SOL transfer (in production, call the program)
            const lamports = CONFIG.PRICE_PER_CUBE_SOL * solanaWeb3.LAMPORTS_PER_SOL;

            // Treasury address - receives the SOL payment
            const treasury = new solanaWeb3.PublicKey(CONFIG.TREASURY_WALLET);

            const transaction = new solanaWeb3.Transaction().add(
                solanaWeb3.SystemProgram.transfer({
                    fromPubkey: this.walletPublicKey,
                    toPubkey: treasury,
                    lamports: lamports,
                })
            );

            // Get recent blockhash
            const { blockhash } = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = this.walletPublicKey;

            this.setPaymentStatus('Please approve in Phantom...');

            // Sign and send
            const signed = await window.solana.signTransaction(transaction);
            const signature = await this.connection.sendRawTransaction(signed.serialize());

            this.setPaymentStatus('Confirming transaction...');

            // Wait for confirmation
            const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');

            if (confirmation.value.err) {
                throw new Error('Transaction failed');
            }

            this.setPaymentStatus(`Confirmed! ${signature.slice(0, 8)}...`);

            // Mark cube as removed
            this.removedCubesCache.add(cubeId);
            this.saveRemovedCubes();
            this.clickedCount++;
            this.myClickedCount++;

            // Animate removal
            this.animateCubeRemoval(cube);

            return true;

        } catch (error) {
            console.error('Payment failed:', error);
            if (error.message?.includes('User rejected')) {
                this.setPaymentStatus('Transaction cancelled');
            } else {
                this.setPaymentStatus('Transaction failed');
            }
            return false;
        } finally {
            this.isProcessingPayment = false;
        }
    }

    updateLayerColors() {
        this.cubes.forEach(cube => {
            if (!cube.visible) return;
            cube.userData.originalColor = CONFIG.CUBE_COLOR;
            cube.material.color.setHex(CONFIG.CUBE_COLOR);
            cube.material.opacity = 1;
            cube.material.transparent = false;
        });
    }

    checkLayerComplete() {
        const remainingInLayer = this.cubeData.some(d => d.visible && d.shellLayer === this.currentLayer);
        if (!remainingInLayer && this.currentLayer < MAX_LAYERS - 1) {
            this.currentLayer++;
            this.loadCurrentLayerMeshes();
        }
    }

    syncLayerFromState() {
        const visibleLayers = this.cubeData.filter(d => d.visible).map(d => d.shellLayer);
        if (visibleLayers.length === 0) {
            this.currentLayer = 0;
            return;
        }
        this.currentLayer = Math.min(...visibleLayers);
    }

    onMouseMove(event) {
        this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

        if (this.isDragging) {
            const deltaX = event.clientX - this.previousMousePosition.x;
            const deltaY = event.clientY - this.previousMousePosition.y;

            if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
                this.dragMoved = true;
            }

            this.cameraTheta -= deltaX * 0.01;
            this.cameraPhi += deltaY * 0.01;
            this.cameraPhi = Math.max(0.1, Math.min(Math.PI - 0.1, this.cameraPhi));

            this.previousMousePosition = { x: event.clientX, y: event.clientY };
            return;
        }

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const clickableCubes = this.getClickableCubes();
        const intersects = this.raycaster.intersectObjects(clickableCubes);

        if (this.hoveredCube) {
            this.hoveredCube.material.color.setHex(this.hoveredCube.userData.originalColor);
            this.hoveredCube.scale.set(1, 1, 1);
            this.hoveredCube = null;
        }

        if (intersects.length > 0) {
            this.hoveredCube = intersects[0].object;
            this.hoveredCube.material.color.setHex(CONFIG.CUBE_HOVER_COLOR);
            this.hoveredCube.scale.set(1.1, 1.1, 1.1);
        }
    }

    async handleCubeClick(event) {
        if (event.target.tagName === 'BUTTON') return;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const clickableCubes = this.getClickableCubes();
        const intersects = this.raycaster.intersectObjects(clickableCubes);

        if (intersects.length > 0) {
            const cube = intersects[0].object;
            await this.removeCubeWithPayment(cube);
        }
    }

    animateCubeRemoval(cube) {
        if (this.animatingCubes.has(cube)) return;

        this.animatingCubes.add(cube);

        const startTime = Date.now();
        const startScale = { x: cube.scale.x, y: cube.scale.y, z: cube.scale.z };
        const startY = cube.position.y;

        const animateRemoval = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / CONFIG.REMOVE_ANIMATION_DURATION, 1);
            const easeProgress = 1 - Math.pow(1 - progress, 3);

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
                if (cube.userData.dataRef) {
                    cube.userData.dataRef.visible = false;
                    this.addHoleMarker(cube.userData.dataRef);
                }
                this.animatingCubes.delete(cube);
                this.updateStats();
                this.checkLayerComplete();
                this.checkWinner();
            }
        };

        animateRemoval();
    }

    updateStats() {
        const remaining = this.cubeData.filter(d => d.visible).length;
        document.getElementById('cube-count').textContent = remaining.toLocaleString();
        document.getElementById('clicked-count').textContent = this.clickedCount.toLocaleString();
        document.getElementById('layer-count').textContent = this.currentLayer + 1;
        document.getElementById('total-layers').textContent = MAX_LAYERS;
        if (this.myClickedEl) {
            this.myClickedEl.textContent = this.myClickedCount;
        }
    }

    checkWinner() {
        const remaining = this.cubeData.filter(d => d.visible).length;
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
        // In production, this would require owner authority on the contract
        this.hideWinnerModal();
        this.clickedCount = 0;
        this.myClickedCount = 0;
        this.animatingCubes.clear();
        this.currentLayer = 0;
        this.removedCubesCache.clear();

        this.cubeData.forEach(d => {
            d.visible = true;
        });

        localStorage.removeItem('removedCubes');
        this.loadCurrentLayerMeshes();
        this.updateStats();
    }

    addHoleMarker(data) {
        if (data.shellLayer !== this.currentLayer) return;
        if (this.holeMarkers.has(data.id)) return;

        const size = CONFIG.CUBE_SIZE * 0.35;
        const geometry = new THREE.BoxGeometry(size, size, size);
        const material = new THREE.MeshBasicMaterial({
            color: CONFIG.HOLE_COLOR,
            transparent: true,
            opacity: 0.6,
        });
        const marker = new THREE.Mesh(geometry, material);
        marker.position.set(
            data.gridX * CONFIG.CUBE_SPACING,
            data.originalPosY,
            data.gridZ * CONFIG.CUBE_SPACING
        );
        this.scene.add(marker);
        this.holeMarkers.set(data.id, marker);
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

        if (this.autoRotate) {
            this.cameraTheta += 0.002;
        }

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
