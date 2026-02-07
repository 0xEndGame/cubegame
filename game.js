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
    MIN_ZOOM: 20,
    MAX_ZOOM: 400,
    ZOOM_SPEED: 3,

    // Monad EVM Configuration
    CHAIN_ID: 143,
    CHAIN_NAME: 'Monad',
    CURRENCY_SYMBOL: 'MON',
    CURRENCY_DECIMALS: 18,
    RPC_URL: 'https://rpc.monad.xyz',
    BLOCK_EXPLORER: 'https://monadexplorer.com',
    PRICE_PER_CUBE: '0.0001', // 0.0001 MON per cube
    TREASURY_WALLET: '0x0000000000000000000000000000000000000000', // TODO: set your EVM treasury address
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
        this.myClickedCount = 0;
        this.animatingCubes = new Set();
        this.cameraDistance = 160;
        this.currentLayer = 0;

        // EVM wallet state
        this.provider = null;
        this.signer = null;
        this.walletAddress = null;
        this.isProcessingPayment = false;
        this.removedCubesCache = new Set();

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
        this.initWallet();
        this.updateWalletDisplay();
        this.updateLayerColors();
        this.animate();
        this.updateStats();
    }

    // Initialize EVM provider
    async initWallet() {
        try {
            if (window.ethereum) {
                this.provider = new ethers.BrowserProvider(window.ethereum);

                // Listen for account/chain changes
                window.ethereum.on('accountsChanged', (accounts) => {
                    if (accounts.length === 0) {
                        this.walletAddress = null;
                        this.signer = null;
                        this.setWalletStatus('Not connected');
                    } else {
                        this.walletAddress = accounts[0];
                        this.setWalletStatus(`Connected: ${this.shortenAddress(this.walletAddress)}`);
                    }
                    this.updateConnectButton();
                });

                window.ethereum.on('chainChanged', () => {
                    window.location.reload();
                });

                // Check if already connected
                const accounts = await window.ethereum.request({ method: 'eth_accounts' });
                if (accounts.length > 0) {
                    this.signer = await this.provider.getSigner();
                    this.walletAddress = accounts[0];
                    this.setWalletStatus(`Connected: ${this.shortenAddress(this.walletAddress)}`);
                    this.updateConnectButton();
                    await this.ensureMonadNetwork();
                }

                this.setPaymentStatus('Ready');
            } else {
                this.setPaymentStatus('No EVM wallet detected');
            }

            // Load cached removed cubes
            await this.syncRemovedCubesFromCache();
        } catch (error) {
            console.error('Wallet init error:', error);
            this.setPaymentStatus('Wallet initialization failed');
        }
    }

    // Prompt user to switch to Monad network
    async ensureMonadNetwork() {
        if (!window.ethereum) return;

        try {
            const chainIdHex = '0x' + CONFIG.CHAIN_ID.toString(16);
            const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });

            if (currentChainId !== chainIdHex) {
                try {
                    await window.ethereum.request({
                        method: 'wallet_switchEthereumChain',
                        params: [{ chainId: chainIdHex }],
                    });
                } catch (switchError) {
                    // Chain not added yet — add it
                    if (switchError.code === 4902) {
                        await window.ethereum.request({
                            method: 'wallet_addEthereumChain',
                            params: [{
                                chainId: chainIdHex,
                                chainName: CONFIG.CHAIN_NAME,
                                nativeCurrency: {
                                    name: CONFIG.CURRENCY_SYMBOL,
                                    symbol: CONFIG.CURRENCY_SYMBOL,
                                    decimals: CONFIG.CURRENCY_DECIMALS,
                                },
                                rpcUrls: [CONFIG.RPC_URL],
                                blockExplorerUrls: [CONFIG.BLOCK_EXPLORER],
                            }],
                        });
                    } else {
                        throw switchError;
                    }
                }
            }
        } catch (error) {
            console.error('Network switch error:', error);
            this.setPaymentStatus('Please switch to Monad network');
        }
    }

    // Load removed cubes from localStorage cache
    async syncRemovedCubesFromCache() {
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
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        this.renderer.shadowMap.enabled = false;
        document.getElementById('game-container').appendChild(this.renderer.domElement);

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
        this.scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(10, 20, 10);
        this.scene.add(directionalLight);

        const pointLight = new THREE.PointLight(0x667eea, 0.6, 100);
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
                const material = new THREE.MeshLambertMaterial({
                    color: CONFIG.CUBE_COLOR,
                    opacity: 1,
                    transparent: false,
                });

                const cube = new THREE.Mesh(sharedGeometry.clone(), material);
                cube.position.set(
                    data.gridX * CONFIG.CUBE_SPACING,
                    data.gridY * CONFIG.CUBE_SPACING,
                    data.gridZ * CONFIG.CUBE_SPACING
                );
                cube.castShadow = false;
                cube.receiveShadow = false;

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
        this.connectBtn.textContent = this.walletAddress ? 'Disconnect Wallet' : 'Connect Wallet';
    }

    shortenAddress(address) {
        if (!address) return '';
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    async connectWallet() {
        if (!window.ethereum) {
            this.setWalletStatus('No wallet found');
            alert('Please install MetaMask or another EVM wallet to play!\nhttps://metamask.io');
            return null;
        }

        try {
            this.provider = new ethers.BrowserProvider(window.ethereum);
            const accounts = await this.provider.send('eth_requestAccounts', []);
            this.signer = await this.provider.getSigner();
            this.walletAddress = accounts[0];
            this.setWalletStatus(`Connected: ${this.shortenAddress(this.walletAddress)}`);
            this.updateConnectButton();

            await this.ensureMonadNetwork();

            return this.walletAddress;
        } catch (error) {
            this.setWalletStatus('Connection rejected');
            console.error('Wallet connection rejected', error);
            return null;
        }
    }

    async disconnectWallet() {
        this.walletAddress = null;
        this.signer = null;
        this.setWalletStatus('Not connected');
        this.setPaymentStatus('Disconnected');
        this.updateConnectButton();
    }

    async handleConnectButton() {
        if (this.walletAddress) {
            await this.disconnectWallet();
        } else {
            await this.connectWallet();
        }
    }

    // Execute MON payment and remove cube
    async removeCubeWithPayment(cube) {
        if (this.isProcessingPayment) {
            this.setPaymentStatus('Transaction in progress...');
            return false;
        }

        if (!window.ethereum) {
            this.setPaymentStatus('EVM wallet required');
            alert('Please install MetaMask or another EVM wallet to play!\nhttps://metamask.io');
            return false;
        }

        // Connect wallet if needed
        if (!this.walletAddress) {
            const connected = await this.connectWallet();
            if (!connected) return false;
        }

        const cubeId = cube.userData.id;

        if (this.removedCubesCache.has(cubeId)) {
            this.setPaymentStatus('Cube already removed');
            return false;
        }

        this.isProcessingPayment = true;
        this.setPaymentStatus('Creating transaction...');

        try {
            if (!CONFIG.TREASURY_WALLET || CONFIG.TREASURY_WALLET === '0x0000000000000000000000000000000000000000') {
                this.setPaymentStatus('Treasury wallet not configured');
                throw new Error('Treasury wallet not configured in game.js');
            }

            // Ensure we're on the right network
            await this.ensureMonadNetwork();

            // Re-init provider/signer after potential network switch
            this.provider = new ethers.BrowserProvider(window.ethereum);
            this.signer = await this.provider.getSigner();

            const value = ethers.parseEther(CONFIG.PRICE_PER_CUBE);

            this.setPaymentStatus('Please approve in wallet...');

            const tx = await this.signer.sendTransaction({
                to: CONFIG.TREASURY_WALLET,
                value: value,
            });

            this.setPaymentStatus('Confirming transaction...');

            const receipt = await tx.wait(1);

            if (receipt.status === 0) {
                throw new Error('Transaction reverted');
            }

            this.setPaymentStatus(`Confirmed! ${tx.hash.slice(0, 10)}...`);

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
            const msg = error.message || '';
            if (msg.includes('user rejected') || msg.includes('ACTION_REJECTED')) {
                this.setPaymentStatus('Transaction cancelled');
            } else if (msg.includes('insufficient funds')) {
                this.setPaymentStatus('Insufficient MON balance');
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
