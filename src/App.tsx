import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Heart,
  Trophy,
  RotateCcw,
  Volume2,
  VolumeX,
  Pause,
  Play,
  HelpCircle,
  Download,
  Copy,
  Check,
  Gamepad2,
  Sparkles,
  Shield,
  Zap,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
} from 'lucide-react';

// Grid Dimensions
const GRID_W = 160;
const GRID_H = 120;
const CELL_EMPTY = 0;   // Unclaimed dark space
const CELL_CLAIMED = 1; // Safe secured territory
const CELL_TRAIL = 2;   // Active drawing trail
const BORDER_SIZE = 2;
const WIN_PERCENTAGE = 75;

// Color Palette (Neon retro arcade)
const COLOR_EMPTY_RGB = [6, 8, 16];       // Deep space black
const COLOR_CLAIMED_RGB = [16, 185, 129];  // Emerald neon green
const COLOR_TRAIL_RGB = [0, 240, 255];     // Bright cyan

interface Monster {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  hue: number;
  rotation: number;
  rotationSpeed: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  life: number;
  maxLife: number;
  size: number;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Game UI States
  const [gameState, setGameState] = useState<'IDLE' | 'PLAYING' | 'PAUSED' | 'CLEAR' | 'GAMEOVER'>('PLAYING');
  const [lives, setLives] = useState(3);
  const [score, setScore] = useState(0);
  const [stage, setStage] = useState(1);
  const [claimedPct, setClaimedPct] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [copied, setCopied] = useState(false);

  // Web Audio Synth
  const audioCtxRef = useRef<AudioContext | null>(null);

  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        audioCtxRef.current = new AudioContextClass();
      }
    }
    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }, []);

  const playTone = useCallback((freq: number, type: OscillatorType, duration: number, volume: number = 0.1) => {
    if (isMuted) return;
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch {
      // Audio context policy guard
    }
  }, [getAudioCtx, isMuted]);

  const playSound = useCallback((soundName: 'trail' | 'capture' | 'hit' | 'win' | 'bounce') => {
    if (isMuted) return;
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const now = ctx.currentTime;

      if (soundName === 'trail') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.exponentialRampToValueAtTime(180, now + 0.05);
        gain.gain.setValueAtTime(0.04, now);
        gain.gain.linearRampToValueAtTime(0.001, now + 0.05);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(now + 0.05);
      } else if (soundName === 'bounce') {
        playTone(380, 'sine', 0.06, 0.03);
      } else if (soundName === 'capture') {
        // Ascending 4-note chime
        const notes = [440, 554, 659, 880];
        notes.forEach((freq, idx) => {
          setTimeout(() => {
            playTone(freq, 'triangle', 0.18, 0.08);
          }, idx * 60);
        });
      } else if (soundName === 'hit') {
        // Explosion noise + pitch drop
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(240, now);
        osc.frequency.exponentialRampToValueAtTime(40, now + 0.35);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(now + 0.35);
      } else if (soundName === 'win') {
        const fanfare = [523.25, 659.25, 783.99, 1046.5];
        fanfare.forEach((freq, idx) => {
          setTimeout(() => {
            playTone(freq, 'sine', 0.3, 0.12);
          }, idx * 100);
        });
      }
    } catch {
      // Audio context guard
    }
  }, [getAudioCtx, isMuted, playTone]);

  // Core Game State Refs (Engine)
  const cellsRef = useRef<Uint8Array>(new Uint8Array(GRID_W * GRID_H));
  const imageDataRef = useRef<ImageData | null>(null);

  const playerRef = useRef({
    x: Math.floor(GRID_W / 2),
    y: 1,
    dx: 0,
    dy: 0,
    isDrawing: false,
    trail: [] as { x: number; y: number }[],
    speed: 1,
    invincibleTimer: 0,
    flashState: true,
  });

  const monstersRef = useRef<Monster[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const screenShakeRef = useRef(0);
  const keysDownRef = useRef<Record<string, boolean>>({});
  const animationFrameIdRef = useRef<number | null>(null);

  // Helper: Set offscreen pixel color
  const setCellColor = (idx: number, r: number, g: number, b: number) => {
    if (!imageDataRef.current) return;
    const p = idx * 4;
    imageDataRef.current.data[p] = r;
    imageDataRef.current.data[p + 1] = g;
    imageDataRef.current.data[p + 2] = b;
    imageDataRef.current.data[p + 3] = 255;
  };

  // Helper: Count interior claimed cells
  const calculatePercentage = useCallback(() => {
    const totalInterior = (GRID_W - 2 * BORDER_SIZE) * (GRID_H - 2 * BORDER_SIZE);
    let claimedInterior = 0;
    const cells = cellsRef.current;

    for (let y = BORDER_SIZE; y < GRID_H - BORDER_SIZE; y++) {
      for (let x = BORDER_SIZE; x < GRID_W - BORDER_SIZE; x++) {
        if (cells[y * GRID_W + x] === CELL_CLAIMED) {
          claimedInterior++;
        }
      }
    }
    const pct = Math.floor((claimedInterior / totalInterior) * 1000) / 10;
    setClaimedPct(pct);
    return pct;
  }, []);

  // Spawn Monsters based on stage
  const createMonsters = useCallback((stageNum: number) => {
    const count = Math.min(2 + (stageNum - 1), 4); // 2 on stage 1, 3 on stage 2, 4 on stage 3+
    const list: Monster[] = [];
    const baseSpeed = 0.8 + stageNum * 0.12;

    for (let i = 0; i < count; i++) {
      const angle = (Math.PI / 4) + (i * (Math.PI / 2)) + (Math.random() - 0.5) * 0.3;
      list.push({
        x: GRID_W * (0.3 + 0.4 * Math.random()),
        y: GRID_H * (0.3 + 0.4 * Math.random()),
        vx: Math.cos(angle) * baseSpeed,
        vy: Math.sin(angle) * baseSpeed,
        radius: 2.4,
        hue: 350 + i * 20,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() > 0.5 ? 1 : -1) * 0.08,
      });
    }
    return list;
  }, []);

  // Initialize Map
  const initMap = useCallback((currentStage: number) => {
    const cells = cellsRef.current;
    if (!offscreenCanvasRef.current) {
      const offCanvas = document.createElement('canvas');
      offCanvas.width = GRID_W;
      offCanvas.height = GRID_H;
      offscreenCanvasRef.current = offCanvas;
    }
    const offCtx = offscreenCanvasRef.current.getContext('2d');
    if (!offCtx) return;

    const imgData = offCtx.createImageData(GRID_W, GRID_H);
    imageDataRef.current = imgData;

    // Reset grid: outer borders are claimed, inside is unclaimed
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const idx = y * GRID_W + x;
        const isBorder = x < BORDER_SIZE || x >= GRID_W - BORDER_SIZE || y < BORDER_SIZE || y >= GRID_H - BORDER_SIZE;
        if (isBorder) {
          cells[idx] = CELL_CLAIMED;
          setCellColor(idx, COLOR_CLAIMED_RGB[0], COLOR_CLAIMED_RGB[1], COLOR_CLAIMED_RGB[2]);
        } else {
          cells[idx] = CELL_EMPTY;
          setCellColor(idx, COLOR_EMPTY_RGB[0], COLOR_EMPTY_RGB[1], COLOR_EMPTY_RGB[2]);
        }
      }
    }

    offCtx.putImageData(imgData, 0, 0);

    // Reset player position
    playerRef.current = {
      x: Math.floor(GRID_W / 2),
      y: 1,
      dx: 0,
      dy: 0,
      isDrawing: false,
      trail: [],
      speed: 1,
      invincibleTimer: 60, // 1 sec invulnerable flash
      flashState: true,
    };

    monstersRef.current = createMonsters(currentStage);
    particlesRef.current = [];
    calculatePercentage();
  }, [calculatePercentage, createMonsters]);

  // Spark / Explosion Particle Generator
  const spawnParticles = (x: number, y: number, color: string, count: number = 15) => {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 2.5 + 0.8;
      particlesRef.current.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color,
        life: 0,
        maxLife: Math.floor(Math.random() * 20 + 20),
        size: Math.random() * 2.5 + 1.2,
      });
    }
  };

  // Execute Flood Fill Land Capture
  const completeCapture = useCallback(() => {
    const cells = cellsRef.current;
    const player = playerRef.current;
    const monsters = monstersRef.current;
    const reachable = new Uint8Array(GRID_W * GRID_H);
    const queue = new Int32Array(GRID_W * GRID_H);
    let qHead = 0;
    let qTail = 0;

    // For each monster, find starting unclaimed cell to flood fill
    monsters.forEach((m) => {
      const mx = Math.round(m.x);
      const my = Math.round(m.y);
      let startIdx = -1;

      for (let r = 0; r <= 5 && startIdx === -1; r++) {
        for (let dy = -r; dy <= r && startIdx === -1; dy++) {
          for (let dx = -r; dx <= r && startIdx === -1; dx++) {
            const sx = mx + dx;
            const sy = my + dy;
            if (sx >= 0 && sx < GRID_W && sy >= 0 && sy < GRID_H) {
              const idx = sy * GRID_W + sx;
              if (cells[idx] === CELL_EMPTY) {
                startIdx = idx;
              }
            }
          }
        }
      }

      if (startIdx !== -1 && reachable[startIdx] === 0) {
        reachable[startIdx] = 1;
        queue[qTail++] = startIdx;
      }
    });

    // BFS Flood Fill all regions reachable by any monster
    while (qHead < qTail) {
      const curr = queue[qHead++];
      const cx = curr % GRID_W;
      const cy = Math.floor(curr / GRID_W);

      const neighbors = [
        cx > 0 ? curr - 1 : -1,
        cx < GRID_W - 1 ? curr + 1 : -1,
        cy > 0 ? curr - GRID_W : -1,
        cy < GRID_H - 1 ? curr + GRID_W : -1,
      ];

      for (let i = 0; i < 4; i++) {
        const nidx = neighbors[i];
        if (nidx !== -1 && reachable[nidx] === 0 && cells[nidx] === CELL_EMPTY) {
          reachable[nidx] = 1;
          queue[qTail++] = nidx;
        }
      }
    }

    // Capture territory: any cell not reached by monster becomes claimed!
    let newlyCaptured = 0;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const idx = y * GRID_W + x;
        if (cells[idx] === CELL_EMPTY && reachable[idx] === 0) {
          cells[idx] = CELL_CLAIMED;
          setCellColor(idx, COLOR_CLAIMED_RGB[0], COLOR_CLAIMED_RGB[1], COLOR_CLAIMED_RGB[2]);
          newlyCaptured++;
        } else if (cells[idx] === CELL_TRAIL) {
          cells[idx] = CELL_CLAIMED;
          setCellColor(idx, COLOR_CLAIMED_RGB[0], COLOR_CLAIMED_RGB[1], COLOR_CLAIMED_RGB[2]);
          newlyCaptured++;
        }
      }
    }

    // Commit changes to offscreen canvas
    if (offscreenCanvasRef.current && imageDataRef.current) {
      const offCtx = offscreenCanvasRef.current.getContext('2d');
      if (offCtx) {
        offCtx.putImageData(imageDataRef.current, 0, 0);
      }
    }

    // Reset player trail state
    player.isDrawing = false;
    player.trail = [];

    // Award score & particles
    const earnedScore = newlyCaptured * 15;
    setScore((prev) => prev + earnedScore);
    spawnParticles(player.x, player.y, '#00ff9d', 25);
    playSound('capture');

    // Update Percentage and check win condition
    const newPct = calculatePercentage();
    if (newPct >= WIN_PERCENTAGE) {
      setGameState('CLEAR');
      playSound('win');
      spawnParticles(GRID_W / 2, GRID_H / 2, '#38bdf8', 60);
      spawnParticles(GRID_W / 2, GRID_H / 2, '#4ade80', 60);
    }
  }, [calculatePercentage, playSound]);

  // Handle Player Hit (life loss)
  const handlePlayerHit = useCallback(() => {
    const player = playerRef.current;
    if (player.invincibleTimer > 0) return;

    playSound('hit');
    screenShakeRef.current = 14;
    spawnParticles(player.x, player.y, '#ff0055', 30);

    // Erase active trail from grid and canvas
    const cells = cellsRef.current;
    player.trail.forEach((pt) => {
      const idx = pt.y * GRID_W + pt.x;
      cells[idx] = CELL_EMPTY;
      setCellColor(idx, COLOR_EMPTY_RGB[0], COLOR_EMPTY_RGB[1], COLOR_EMPTY_RGB[2]);
    });

    if (offscreenCanvasRef.current && imageDataRef.current) {
      const offCtx = offscreenCanvasRef.current.getContext('2d');
      if (offCtx) {
        offCtx.putImageData(imageDataRef.current, 0, 0);
      }
    }

    player.trail = [];
    player.isDrawing = false;
    player.dx = 0;
    player.dy = 0;
    player.x = Math.floor(GRID_W / 2);
    player.y = 1;
    player.invincibleTimer = 90; // ~1.5 seconds safety flash

    setLives((prevLives) => {
      const nextLives = prevLives - 1;
      if (nextLives <= 0) {
        setGameState('GAMEOVER');
      }
      return nextLives;
    });
  }, [playSound]);

  // Step Player Movement
  const updatePlayer = useCallback(() => {
    const player = playerRef.current;
    const cells = cellsRef.current;

    if (player.invincibleTimer > 0) {
      player.invincibleTimer--;
      if (player.invincibleTimer % 6 === 0) {
        player.flashState = !player.flashState;
      }
    } else {
      player.flashState = true;
    }

    // Determine direction from keys pressed
    const keys = keysDownRef.current;
    let nextDx = 0;
    let nextDy = 0;

    if (keys['ArrowUp'] || keys['KeyW']) nextDy = -1;
    else if (keys['ArrowDown'] || keys['KeyS']) nextDy = 1;
    else if (keys['ArrowLeft'] || keys['KeyA']) nextDx = -1;
    else if (keys['ArrowRight'] || keys['KeyD']) nextDx = 1;

    // Prevent immediate 180-degree turnaround when drawing
    if (player.isDrawing && player.trail.length >= 2) {
      const prevStep = player.trail[player.trail.length - 2];
      if (player.x + nextDx === prevStep.x && player.y + nextDy === prevStep.y) {
        nextDx = player.dx;
        nextDy = player.dy;
      }
    }

    if (nextDx !== 0 || nextDy !== 0) {
      player.dx = nextDx;
      player.dy = nextDy;
    }

    // Move player in current direction
    if (player.dx === 0 && player.dy === 0) return;

    const nx = player.x + player.dx;
    const ny = player.y + player.dy;

    // Boundary check
    if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) {
      player.dx = 0;
      player.dy = 0;
      return;
    }

    const nextIdx = ny * GRID_W + nx;
    const nextCellState = cells[nextIdx];
    const currentIdx = player.y * GRID_W + player.x;
    const currentCellState = cells[currentIdx];

    // CASE 1: Currently on safe land (not drawing)
    if (!player.isDrawing) {
      if (nextCellState === CELL_CLAIMED) {
        // Safe movement along boundary
        player.x = nx;
        player.y = ny;
      } else if (nextCellState === CELL_EMPTY) {
        // Stepping into uncharted territory! Start drawing trail!
        player.isDrawing = true;
        player.x = nx;
        player.y = ny;
        player.trail = [{ x: nx, y: ny }];
        cells[nextIdx] = CELL_TRAIL;
        setCellColor(nextIdx, COLOR_TRAIL_RGB[0], COLOR_TRAIL_RGB[1], COLOR_TRAIL_RGB[2]);
        if (offscreenCanvasRef.current && imageDataRef.current) {
          const offCtx = offscreenCanvasRef.current.getContext('2d');
          if (offCtx) offCtx.putImageData(imageDataRef.current, 0, 0);
        }
        playSound('trail');
      }
    }
    // CASE 2: Currently drawing a line
    else {
      if (nextCellState === CELL_TRAIL) {
        // Player ran into their own active line: fatal!
        handlePlayerHit();
      } else if (nextCellState === CELL_EMPTY) {
        // Continue drawing line through empty space
        player.x = nx;
        player.y = ny;
        player.trail.push({ x: nx, y: ny });
        cells[nextIdx] = CELL_TRAIL;
        setCellColor(nextIdx, COLOR_TRAIL_RGB[0], COLOR_TRAIL_RGB[1], COLOR_TRAIL_RGB[2]);
        if (offscreenCanvasRef.current && imageDataRef.current) {
          const offCtx = offscreenCanvasRef.current.getContext('2d');
          if (offCtx) offCtx.putImageData(imageDataRef.current, 0, 0);
        }
        if (player.trail.length % 4 === 0) {
          playSound('trail');
        }
      } else if (nextCellState === CELL_CLAIMED) {
        // Reconnected to safe territory! LOOP CLOSED!
        player.x = nx;
        player.y = ny;
        player.dx = 0;
        player.dy = 0;
        completeCapture();
      }
    }
  }, [completeCapture, handlePlayerHit, playSound]);

  // Step Monsters Physics & Collisions
  const updateMonsters = useCallback(() => {
    const monsters = monstersRef.current;
    const cells = cellsRef.current;
    const player = playerRef.current;

    for (let i = 0; i < monsters.length; i++) {
      const m = monsters[i];
      m.rotation += m.rotationSpeed;

      // Predicted next positions
      const nextX = m.x + m.vx;
      const nextY = m.y + m.vy;

      // Bounce horizontally if colliding with claimed territory
      const sampleX = Math.round(nextX + (m.vx > 0 ? m.radius : -m.radius));
      const sampleYForX = Math.round(m.y);
      if (
        sampleX < 0 ||
        sampleX >= GRID_W ||
        sampleYForX < 0 ||
        sampleYForX >= GRID_H ||
        cells[sampleYForX * GRID_W + sampleX] === CELL_CLAIMED
      ) {
        m.vx = -m.vx * (0.95 + Math.random() * 0.1);
        playSound('bounce');
      } else {
        m.x = nextX;
      }

      // Bounce vertically if colliding with claimed territory
      const sampleY = Math.round(nextY + (m.vy > 0 ? m.radius : -m.radius));
      const sampleXForY = Math.round(m.x);
      if (
        sampleY < 0 ||
        sampleY >= GRID_H ||
        sampleXForY < 0 ||
        sampleXForY >= GRID_H ||
        cells[sampleY * GRID_W + sampleXForY] === CELL_CLAIMED
      ) {
        m.vy = -m.vy * (0.95 + Math.random() * 0.1);
        playSound('bounce');
      } else {
        m.y = nextY;
      }

      // Normalize monster speed to prevent slowdown or extreme speed
      const curSpeed = Math.hypot(m.vx, m.vy);
      const targetSpeed = 0.85 + stage * 0.1;
      if (curSpeed > 0) {
        m.vx = (m.vx / curSpeed) * targetSpeed;
        m.vy = (m.vy / curSpeed) * targetSpeed;
      }

      // Check collision with Player & Active Trail while drawing
      if (player.isDrawing && player.invincibleTimer <= 0) {
        // 1. Monster touches player body
        const distToPlayer = Math.hypot(m.x - player.x, m.y - player.y);
        if (distToPlayer < m.radius + 1.2) {
          handlePlayerHit();
          return;
        }

        // 2. Monster touches active trail
        for (let j = 0; j < player.trail.length; j++) {
          const pt = player.trail[j];
          const distToTrail = Math.hypot(m.x - pt.x, m.y - pt.y);
          if (distToTrail < m.radius + 0.8) {
            handlePlayerHit();
            return;
          }
        }
      }
    }
  }, [handlePlayerHit, playSound, stage]);

  // Main Canvas Render Loop
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const scaleX = width / GRID_W;
    const scaleY = height / GRID_H;

    ctx.save();

    // Screen Shake effect
    if (screenShakeRef.current > 0) {
      const shakeX = (Math.random() - 0.5) * screenShakeRef.current;
      const shakeY = (Math.random() - 0.5) * screenShakeRef.current;
      ctx.translate(shakeX, shakeY);
      screenShakeRef.current = Math.max(0, screenShakeRef.current - 0.8);
    }

    // 1. Draw Background Grid & Territory from Offscreen Canvas
    if (offscreenCanvasRef.current) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(offscreenCanvasRef.current, 0, 0, width, height);
    }

    // Subtle Cyber Grid Overlay
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.025)';
    ctx.lineWidth = 1;
    const gridSize = 40;
    for (let gx = 0; gx < width; gx += gridSize) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, height);
      ctx.stroke();
    }
    for (let gy = 0; gy < height; gy += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(width, gy);
      ctx.stroke();
    }

    // 2. Draw Active Trail with glowing neon stroke
    const player = playerRef.current;
    if (player.trail.length > 1) {
      ctx.save();
      ctx.strokeStyle = '#00f0ff';
      ctx.lineWidth = Math.max(2, scaleX * 1.2);
      ctx.shadowColor = '#00f0ff';
      ctx.shadowBlur = 10;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(player.trail[0].x * scaleX + scaleX / 2, player.trail[0].y * scaleY + scaleY / 2);
      for (let i = 1; i < player.trail.length; i++) {
        ctx.lineTo(player.trail[i].x * scaleX + scaleX / 2, player.trail[i].y * scaleY + scaleY / 2);
      }
      ctx.stroke();
      ctx.restore();
    }

    // 3. Draw Monsters (Fiery Neon Red/Crimson Plasma entities)
    const monsters = monstersRef.current;
    monsters.forEach((m) => {
      const mx = m.x * scaleX;
      const my = m.y * scaleY;
      const r = m.radius * scaleX;

      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(m.rotation);

      // Outer Glowing Aura
      ctx.shadowColor = `hsl(${m.hue}, 100%, 55%)`;
      ctx.shadowBlur = 14;

      // Rotating Spikes / Hazard geometry
      const spikeCount = 8;
      ctx.fillStyle = `hsl(${m.hue}, 100%, 50%)`;
      ctx.beginPath();
      for (let s = 0; s < spikeCount * 2; s++) {
        const radius = s % 2 === 0 ? r * 1.35 : r * 0.65;
        const ang = (s * Math.PI) / spikeCount;
        const px = Math.cos(ang) * radius;
        const py = Math.sin(ang) * radius;
        if (s === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();

      // Glowing Inner Eye/Core
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.35, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    });

    // 4. Draw Player (Electric Cyan/Blue Diamond Avatar)
    if (player.flashState) {
      const px = player.x * scaleX + scaleX / 2;
      const py = player.y * scaleY + scaleY / 2;
      const pr = scaleX * 1.5;

      ctx.save();
      ctx.translate(px, py);

      ctx.shadowColor = '#38bdf8';
      ctx.shadowBlur = player.isDrawing ? 16 : 8;

      // Player Body
      ctx.fillStyle = player.isDrawing ? '#00f0ff' : '#38bdf8';
      ctx.beginPath();
      ctx.arc(0, 0, pr, 0, Math.PI * 2);
      ctx.fill();

      // Core Highlight
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 0, pr * 0.45, 0, Math.PI * 2);
      ctx.fill();

      // Direction Indicator pointer if moving
      if (player.dx !== 0 || player.dy !== 0) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(player.dx * pr * 1.5, player.dy * pr * 1.5);
        ctx.stroke();
      }

      ctx.restore();
    }

    // 5. Draw Particle Sparks
    const particles = particlesRef.current;
    for (let pIdx = particles.length - 1; pIdx >= 0; pIdx--) {
      const p = particles[pIdx];
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.94;
      p.vy *= 0.94;
      p.life++;

      const progress = p.life / p.maxLife;
      if (progress >= 1) {
        particles.splice(pIdx, 1);
        continue;
      }

      ctx.save();
      ctx.globalAlpha = 1 - progress;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(p.x * scaleX, p.y * scaleY, p.size * (1 - progress * 0.5), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }, []);

  // Main Loop Game Engine Tick
  useEffect(() => {
    let lastTime = performance.now();

    const loop = (now: number) => {
      if (gameState === 'PLAYING') {
        const elapsed = now - lastTime;
        // Run player update at solid tick rate
        if (elapsed > 16) {
          updatePlayer();
          updateMonsters();
          lastTime = now;
        }
      }
      renderCanvas();
      animationFrameIdRef.current = requestAnimationFrame(loop);
    };

    animationFrameIdRef.current = requestAnimationFrame(loop);

    return () => {
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
    };
  }, [gameState, renderCanvas, updateMonsters, updatePlayer]);

  // Handle Keyboard Input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Resume audio context on first key press
      getAudioCtx();

      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }

      if (e.code === 'KeyP') {
        setGameState((prev) => (prev === 'PLAYING' ? 'PAUSED' : prev === 'PAUSED' ? 'PLAYING' : prev));
        return;
      }

      if (e.code === 'KeyM') {
        setIsMuted((prev) => !prev);
        return;
      }

      keysDownRef.current[e.code] = true;
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      keysDownRef.current[e.code] = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [getAudioCtx]);

  // Start / Restart Game
  const handleStartGame = useCallback((stageNum: number = 1) => {
    getAudioCtx();
    setStage(stageNum);
    setLives(3);
    setClaimedPct(0);
    if (stageNum === 1) setScore(0);
    initMap(stageNum);
    setGameState('PLAYING');
  }, [getAudioCtx, initMap]);

  // Initial load
  useEffect(() => {
    initMap(1);
  }, [initMap]);

  // Virtual D-pad for touch / mobile
  const handleVirtualDir = (dir: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT') => {
    getAudioCtx();
    const player = playerRef.current;
    if (dir === 'UP') { player.dx = 0; player.dy = -1; }
    if (dir === 'DOWN') { player.dx = 0; player.dy = 1; }
    if (dir === 'LEFT') { player.dx = -1; player.dy = 0; }
    if (dir === 'RIGHT') { player.dx = 1; player.dy = 0; }
  };

  // Generate Standalone Single-File HTML Code
  const getSingleHtmlContent = useCallback(() => {
    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>땅따먹기 (Neon Qix Retro Game)</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #060810;
      color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 16px;
      user-select: none;
      overflow: hidden;
    }
    .header {
      width: 100%;
      max-width: 800px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      padding: 10px 16px;
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid rgba(56, 189, 248, 0.25);
      border-radius: 8px;
    }
    .stat-badge {
      font-size: 14px;
      font-weight: bold;
      letter-spacing: 0.5px;
    }
    .text-cyan { color: #00f0ff; }
    .text-green { color: #10b981; }
    .text-red { color: #ff0055; }
    .progress-bar-wrap {
      flex: 1;
      max-width: 260px;
      margin: 0 16px;
    }
    .progress-track {
      background: #1e293b;
      height: 10px;
      border-radius: 5px;
      overflow: hidden;
      position: relative;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .progress-fill {
      background: linear-gradient(90deg, #10b981, #00f0ff);
      height: 100%;
      width: 0%;
      transition: width 0.2s;
    }
    .target-marker {
      position: absolute;
      left: 75%;
      top: 0;
      bottom: 0;
      width: 2px;
      background: #ff0055;
    }
    .canvas-wrap {
      position: relative;
      border: 2px solid #38bdf8;
      box-shadow: 0 0 24px rgba(56, 189, 248, 0.3);
      border-radius: 6px;
      background: #060810;
    }
    canvas {
      display: block;
      width: 800px;
      height: 600px;
      max-width: 92vw;
      max-height: 68vh;
      aspect-ratio: 4 / 3;
    }
    .overlay {
      position: absolute;
      inset: 0;
      background: rgba(6, 8, 16, 0.85);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      backdrop-filter: blur(4px);
    }
    .overlay h2 {
      font-size: 38px;
      margin-bottom: 12px;
      letter-spacing: 1px;
    }
    .btn {
      background: #0284c7;
      color: #fff;
      border: none;
      padding: 12px 28px;
      font-size: 16px;
      font-weight: bold;
      border-radius: 6px;
      cursor: pointer;
      margin-top: 16px;
      box-shadow: 0 0 14px rgba(2, 132, 199, 0.6);
      transition: all 0.15s;
    }
    .btn:hover { background: #0369a1; transform: scale(1.04); }
    .instructions {
      font-size: 13px;
      color: #94a3b8;
      margin-top: 12px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="stat-badge text-red" id="lives-display">❤️ ❤️ ❤️</div>
    <div class="progress-bar-wrap">
      <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px;">
        <span class="text-green">확보: <b id="pct-display">0.0%</b></span>
        <span style="color:#f59e0b">목표: 75.0%</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" id="progress-fill"></div>
        <div class="target-marker" title="목표 75%"></div>
      </div>
    </div>
    <div class="stat-badge text-cyan">SCORE: <span id="score-display">0</span></div>
  </div>

  <div class="canvas-wrap">
    <canvas id="gameCanvas" width="800" height="600"></canvas>
    <div id="modal" class="overlay" style="display:none;">
      <h2 id="modal-title" class="text-green">STAGE CLEAR!</h2>
      <p id="modal-desc" style="font-size:16px; color:#cbd5e1; margin-bottom:8px;"></p>
      <button id="modal-btn" class="btn">다음 스테이지</button>
    </div>
  </div>

  <div class="instructions">
    조작키: 방향키 (▲ ▼ ◄ ►) 또는 WASD 이동 | 테두리를 벗어나 선을 긋고 다시 안전지대로 돌아오면 영토가 확보됩니다.
  </div>

  <script>
    const GRID_W = 160;
    const GRID_H = 120;
    const CELL_EMPTY = 0;
    const CELL_CLAIMED = 1;
    const CELL_TRAIL = 2;
    const BORDER_SIZE = 2;

    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');
    const offCanvas = document.createElement('canvas');
    offCanvas.width = GRID_W;
    offCanvas.height = GRID_H;
    const offCtx = offCanvas.getContext('2d');
    const imgData = offCtx.createImageData(GRID_W, GRID_H);

    const cells = new Uint8Array(GRID_W * GRID_H);
    let lives = 3;
    let score = 0;
    let stage = 1;
    let gameState = 'PLAYING';

    const player = {
      x: Math.floor(GRID_W / 2),
      y: 1,
      dx: 0,
      dy: 0,
      isDrawing: false,
      trail: [],
      invincible: 60
    };

    let monsters = [];
    const keys = {};

    function setPixel(idx, r, g, b) {
      const p = idx * 4;
      imgData.data[p] = r;
      imgData.data[p+1] = g;
      imgData.data[p+2] = b;
      imgData.data[p+3] = 255;
    }

    function initStage(s) {
      stage = s;
      monsters = [];
      const count = Math.min(2 + (s - 1), 4);
      for (let i = 0; i < count; i++) {
        const ang = (Math.PI / 4) + (i * Math.PI / 2) + (Math.random() - 0.5) * 0.4;
        monsters.push({
          x: GRID_W * (0.3 + Math.random() * 0.4),
          y: GRID_H * (0.3 + Math.random() * 0.4),
          vx: Math.cos(ang) * (0.85 + s * 0.1),
          vy: Math.sin(ang) * (0.85 + s * 0.1),
          radius: 2.4,
          rot: 0
        });
      }

      for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
          const idx = y * GRID_W + x;
          const isBorder = x < BORDER_SIZE || x >= GRID_W - BORDER_SIZE || y < BORDER_SIZE || y >= GRID_H - BORDER_SIZE;
          if (isBorder) {
            cells[idx] = CELL_CLAIMED;
            setPixel(idx, 16, 185, 129);
          } else {
            cells[idx] = CELL_EMPTY;
            setPixel(idx, 6, 8, 16);
          }
        }
      }
      offCtx.putImageData(imgData, 0, 0);

      player.x = Math.floor(GRID_W / 2);
      player.y = 1;
      player.dx = 0;
      player.dy = 0;
      player.isDrawing = false;
      player.trail = [];
      player.invincible = 60;
      updateUI();
    }

    function calculatePct() {
      const total = (GRID_W - 4) * (GRID_H - 4);
      let claimed = 0;
      for (let y = 2; y < GRID_H - 2; y++) {
        for (let x = 2; x < GRID_W - 2; x++) {
          if (cells[y * GRID_W + x] === CELL_CLAIMED) claimed++;
        }
      }
      return Math.floor((claimed / total) * 1000) / 10;
    }

    function updateUI() {
      const pct = calculatePct();
      document.getElementById('pct-display').textContent = pct.toFixed(1) + '%';
      document.getElementById('progress-fill').style.width = Math.min(100, (pct / 75) * 100) + '%';
      document.getElementById('score-display').textContent = score;
      document.getElementById('lives-display').textContent = '❤️'.repeat(Math.max(0, lives));
    }

    function completeCapture() {
      const reachable = new Uint8Array(GRID_W * GRID_H);
      const queue = new Int32Array(GRID_W * GRID_H);
      let qHead = 0, qTail = 0;

      monsters.forEach(m => {
        let mx = Math.round(m.x), my = Math.round(m.y);
        let startIdx = -1;
        for (let r = 0; r <= 4 && startIdx === -1; r++) {
          for (let dy = -r; dy <= r && startIdx === -1; dy++) {
            for (let dx = -r; dx <= r && startIdx === -1; dx++) {
              const sx = mx + dx, sy = my + dy;
              if (sx >= 0 && sx < GRID_W && sy >= 0 && sy < GRID_H) {
                const idx = sy * GRID_W + sx;
                if (cells[idx] === CELL_EMPTY) startIdx = idx;
              }
            }
          }
        }
        if (startIdx !== -1 && reachable[startIdx] === 0) {
          reachable[startIdx] = 1;
          queue[qTail++] = startIdx;
        }
      });

      while (qHead < qTail) {
        const curr = queue[qHead++];
        const cx = curr % GRID_W, cy = Math.floor(curr / GRID_W);
        const neighbors = [
          cx > 0 ? curr - 1 : -1,
          cx < GRID_W - 1 ? curr + 1 : -1,
          cy > 0 ? curr - GRID_W : -1,
          cy < GRID_H - 1 ? curr + GRID_W : -1
        ];
        for (let i = 0; i < 4; i++) {
          const n = neighbors[i];
          if (n !== -1 && reachable[n] === 0 && cells[n] === CELL_EMPTY) {
            reachable[n] = 1;
            queue[qTail++] = n;
          }
        }
      }

      let captured = 0;
      for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
          const idx = y * GRID_W + x;
          if (cells[idx] === CELL_EMPTY && reachable[idx] === 0) {
            cells[idx] = CELL_CLAIMED;
            setPixel(idx, 16, 185, 129);
            captured++;
          } else if (cells[idx] === CELL_TRAIL) {
            cells[idx] = CELL_CLAIMED;
            setPixel(idx, 16, 185, 129);
            captured++;
          }
        }
      }
      offCtx.putImageData(imgData, 0, 0);

      player.isDrawing = false;
      player.trail = [];
      score += captured * 15;
      updateUI();

      if (calculatePct() >= 75) {
        gameState = 'CLEAR';
        showModal('CLEAR!', '축하합니다! 75% 이상의 영토를 확보했습니다.', '다음 스테이지', () => {
          hideModal();
          initStage(stage + 1);
          gameState = 'PLAYING';
        });
      }
    }

    function hitPlayer() {
      if (player.invincible > 0) return;
      player.trail.forEach(pt => {
        const idx = pt.y * GRID_W + pt.x;
        cells[idx] = CELL_EMPTY;
        setPixel(idx, 6, 8, 16);
      });
      offCtx.putImageData(imgData, 0, 0);
      player.trail = [];
      player.isDrawing = false;
      player.x = Math.floor(GRID_W / 2);
      player.y = 1;
      player.dx = 0;
      player.dy = 0;
      player.invincible = 60;
      lives--;
      updateUI();

      if (lives <= 0) {
        gameState = 'GAMEOVER';
        showModal('GAME OVER', '생명을 모두 소진했습니다.', '다시 시작', () => {
          hideModal();
          lives = 3;
          score = 0;
          initStage(1);
          gameState = 'PLAYING';
        });
      }
    }

    function showModal(title, desc, btnText, onAction) {
      const modal = document.getElementById('modal');
      document.getElementById('modal-title').textContent = title;
      document.getElementById('modal-desc').textContent = desc;
      const btn = document.getElementById('modal-btn');
      btn.textContent = btnText;
      btn.onclick = onAction;
      modal.style.display = 'flex';
    }

    function hideModal() {
      document.getElementById('modal').style.display = 'none';
    }

    window.addEventListener('keydown', e => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      keys[e.code] = true;
    });
    window.addEventListener('keyup', e => { keys[e.code] = false; });

    function update() {
      if (gameState !== 'PLAYING') return;

      if (player.invincible > 0) player.invincible--;

      let ndx = 0, ndy = 0;
      if (keys['ArrowUp'] || keys['KeyW']) ndy = -1;
      else if (keys['ArrowDown'] || keys['KeyS']) ndy = 1;
      else if (keys['ArrowLeft'] || keys['KeyA']) ndx = -1;
      else if (keys['ArrowRight'] || keys['KeyD']) ndx = 1;

      if (ndx !== 0 || ndy !== 0) {
        player.dx = ndx;
        player.dy = ndy;
      }

      if (player.dx !== 0 || player.dy !== 0) {
        const nx = player.x + player.dx;
        const ny = player.y + player.dy;

        if (nx >= 0 && nx < GRID_W && ny >= 0 && ny < GRID_H) {
          const nidx = ny * GRID_W + nx;
          const nextState = cells[nidx];

          if (!player.isDrawing) {
            if (nextState === CELL_CLAIMED) {
              player.x = nx;
              player.y = ny;
            } else if (nextState === CELL_EMPTY) {
              player.isDrawing = true;
              player.x = nx;
              player.y = ny;
              player.trail = [{ x: nx, y: ny }];
              cells[nidx] = CELL_TRAIL;
              setPixel(nidx, 0, 240, 255);
              offCtx.putImageData(imgData, 0, 0);
            }
          } else {
            if (nextState === CELL_TRAIL) {
              hitPlayer();
            } else if (nextState === CELL_EMPTY) {
              player.x = nx;
              player.y = ny;
              player.trail.push({ x: nx, y: ny });
              cells[nidx] = CELL_TRAIL;
              setPixel(nidx, 0, 240, 255);
              offCtx.putImageData(imgData, 0, 0);
            } else if (nextState === CELL_CLAIMED) {
              player.x = nx;
              player.y = ny;
              player.dx = 0;
              player.dy = 0;
              completeCapture();
            }
          }
        }
      }

      // Update Monsters
      monsters.forEach(m => {
        m.rot += 0.05;
        const nX = m.x + m.vx;
        const nY = m.y + m.vy;

        const sX = Math.round(nX + (m.vx > 0 ? m.radius : -m.radius));
        const sY = Math.round(m.y);
        if (sX < 0 || sX >= GRID_W || cells[sY * GRID_W + sX] === CELL_CLAIMED) {
          m.vx = -m.vx;
        } else {
          m.x = nX;
        }

        const sY2 = Math.round(nY + (m.vy > 0 ? m.radius : -m.radius));
        const sX2 = Math.round(m.x);
        if (sY2 < 0 || sY2 >= GRID_H || cells[sY2 * GRID_W + sX2] === CELL_CLAIMED) {
          m.vy = -m.vy;
        } else {
          m.y = nY;
        }

        if (player.isDrawing && player.invincible <= 0) {
          if (Math.hypot(m.x - player.x, m.y - player.y) < m.radius + 1.2) {
            hitPlayer();
            return;
          }
          for (let pt of player.trail) {
            if (Math.hypot(m.x - pt.x, m.y - pt.y) < m.radius + 0.8) {
              hitPlayer();
              return;
            }
          }
        }
      });
    }

    function render() {
      const scaleX = canvas.width / GRID_W;
      const scaleY = canvas.height / GRID_H;

      ctx.drawImage(offCanvas, 0, 0, canvas.width, canvas.height);

      // Active trail glow
      if (player.trail.length > 1) {
        ctx.save();
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 4;
        ctx.shadowColor = '#00f0ff';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.moveTo(player.trail[0].x * scaleX + scaleX/2, player.trail[0].y * scaleY + scaleY/2);
        for (let i = 1; i < player.trail.length; i++) {
          ctx.lineTo(player.trail[i].x * scaleX + scaleX/2, player.trail[i].y * scaleY + scaleY/2);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Monsters
      monsters.forEach(m => {
        ctx.save();
        ctx.translate(m.x * scaleX, m.y * scaleY);
        ctx.rotate(m.rot);
        ctx.fillStyle = '#ff0055';
        ctx.shadowColor = '#ff0055';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        for (let s = 0; s < 12; s++) {
          const r = s % 2 === 0 ? m.radius * scaleX * 1.3 : m.radius * scaleX * 0.7;
          const a = s * Math.PI / 6;
          if (s === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
          else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      });

      // Player
      if (player.invincible % 6 < 3) {
        ctx.save();
        ctx.translate(player.x * scaleX + scaleX/2, player.y * scaleY + scaleY/2);
        ctx.fillStyle = player.isDrawing ? '#00f0ff' : '#38bdf8';
        ctx.shadowColor = '#00f0ff';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(0, 0, scaleX * 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      requestAnimationFrame(render);
    }

    setInterval(update, 1000 / 60);
    initStage(1);
    render();
  </script>
</body>
</html>`;
  }, []);

  const handleDownloadSingleHtml = () => {
    const html = getSingleHtmlContent();
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'qix-land-claim.html';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleCopySingleHtml = () => {
    const html = getSingleHtmlContent();
    navigator.clipboard.writeText(html);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#060810] text-slate-100 p-3 sm:p-5 select-none font-sans">
      {/* Top Arcade Header HUD */}
      <header className="w-full max-w-4xl flex flex-wrap items-center justify-between gap-3 bg-slate-900/80 border border-cyan-500/30 rounded-xl px-4 py-3 backdrop-blur-md shadow-[0_0_20px_rgba(56,189,248,0.15)] mb-3">
        {/* Lives & Stage */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 bg-slate-950/60 px-3 py-1.5 rounded-lg border border-red-500/20">
            <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider">LIVES</span>
            <div className="flex items-center gap-1 ml-1 text-red-500 drop-shadow-[0_0_8px_rgba(239,68,68,0.6)]">
              {Array.from({ length: 3 }).map((_, i) => (
                <Heart
                  key={i}
                  className={`w-4 h-4 transition-transform ${i < lives ? 'fill-red-500 scale-100' : 'text-slate-700 opacity-40 scale-90'}`}
                />
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5 bg-slate-950/60 px-3 py-1.5 rounded-lg border border-cyan-500/20">
            <span className="text-xs text-slate-400 font-semibold">STAGE</span>
            <span className="text-sm font-bold text-cyan-400">{stage}</span>
          </div>
        </div>

        {/* Territory Claim Progress Bar (0% to 100%, 75% target mark) */}
        <div className="flex-1 min-w-[200px] max-w-md mx-2">
          <div className="flex justify-between items-center text-xs mb-1 font-medium">
            <span className="text-emerald-400 flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5" />
              확보 면적: <b className="text-sm text-white font-bold">{claimedPct.toFixed(1)}%</b>
            </span>
            <span className="text-amber-400 font-semibold flex items-center gap-1">
              <Trophy className="w-3.5 h-3.5" /> 목표: 75.0%
            </span>
          </div>
          <div className="relative w-full h-3.5 bg-slate-950 rounded-full overflow-hidden border border-slate-700/60 p-0.5">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 via-teal-400 to-cyan-400 rounded-full transition-all duration-300 shadow-[0_0_10px_rgba(16,185,129,0.5)]"
              style={{ width: `${Math.min(100, (claimedPct / 75) * 100)}%` }}
            />
            {/* 75% target threshold flag */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.9)]"
              style={{ left: '75%' }}
              title="75% 클리어 목표"
            />
          </div>
        </div>

        {/* Score and Quick Actions */}
        <div className="flex items-center gap-3">
          <div className="bg-slate-950/60 px-3.5 py-1.5 rounded-lg border border-emerald-500/20">
            <span className="text-xs text-slate-400 font-semibold block leading-none mb-0.5">SCORE</span>
            <span className="text-sm font-bold text-emerald-400 font-mono tracking-wider">{score.toLocaleString()}</span>
          </div>

          <button
            id="sound-toggle-btn"
            onClick={() => setIsMuted(!isMuted)}
            className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-cyan-400 border border-slate-700 transition"
            title={isMuted ? '음소거 해제' : '음소거'}
          >
            {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>

          <button
            id="pause-toggle-btn"
            onClick={() => setGameState((prev) => (prev === 'PLAYING' ? 'PAUSED' : prev === 'PAUSED' ? 'PLAYING' : prev))}
            className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-cyan-400 border border-slate-700 transition"
            title={gameState === 'PAUSED' ? '재개' : '일시정지'}
          >
            {gameState === 'PAUSED' ? <Play className="w-4 h-4 text-emerald-400" /> : <Pause className="w-4 h-4" />}
          </button>

          <button
            id="help-btn"
            onClick={() => setShowHelp(true)}
            className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-cyan-400 border border-slate-700 transition"
            title="게임 가이드"
          >
            <HelpCircle className="w-4 h-4" />
          </button>

          <button
            id="export-btn"
            onClick={() => setShowExportModal(true)}
            className="flex items-center gap-1 text-xs bg-cyan-600/30 hover:bg-cyan-600/50 text-cyan-300 border border-cyan-500/40 px-2.5 py-1.5 rounded-lg transition"
            title="단일 HTML 파일 다운로드 및 코드 복사"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">단일 HTML</span>
          </button>
        </div>
      </header>

      {/* Main Game Screen Canvas Container */}
      <main className="relative flex items-center justify-center border-2 border-cyan-500/40 rounded-xl overflow-hidden shadow-[0_0_32px_rgba(56,189,248,0.25)] bg-[#060810]">
        <canvas
          id="qix-viewport-canvas"
          ref={canvasRef}
          width={800}
          height={600}
          className="w-full max-w-[800px] h-auto aspect-[4/3] block touch-none"
        />

        {/* Modal: Stage Clear */}
        {gameState === 'CLEAR' && (
          <div className="absolute inset-0 bg-slate-950/85 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center animate-fade-in">
            <div className="p-4 bg-emerald-500/20 border-2 border-emerald-400 rounded-full mb-4 shadow-[0_0_24px_rgba(16,185,129,0.5)]">
              <Trophy className="w-12 h-12 text-emerald-400 animate-bounce" />
            </div>
            <h2 className="text-3xl sm:text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 via-teal-300 to-cyan-400 mb-2 drop-shadow-[0_0_12px_rgba(16,185,129,0.5)]">
              STAGE CLEAR!
            </h2>
            <p className="text-slate-300 text-sm sm:text-base max-w-sm mb-6">
              목표 75%를 달성하여 총 <span className="text-emerald-400 font-bold text-lg">{claimedPct.toFixed(1)}%</span>의 영토를 확보했습니다!
            </p>
            <div className="flex flex-wrap gap-3 justify-center">
              <button
                id="next-stage-btn"
                onClick={() => handleStartGame(stage + 1)}
                className="flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white font-bold px-6 py-3 rounded-xl shadow-[0_0_20px_rgba(16,185,129,0.5)] transition-all hover:scale-105"
              >
                <Zap className="w-4 h-4" /> 다음 스테이지로 도전 (Stage {stage + 1})
              </button>
              <button
                id="restart-stage-btn"
                onClick={() => handleStartGame(stage)}
                className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 px-5 py-3 rounded-xl border border-slate-700 transition"
              >
                <RotateCcw className="w-4 h-4" /> 다시 하기
              </button>
            </div>
          </div>
        )}

        {/* Modal: Game Over */}
        {gameState === 'GAMEOVER' && (
          <div className="absolute inset-0 bg-slate-950/85 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center animate-fade-in">
            <div className="p-4 bg-red-500/20 border-2 border-red-500 rounded-full mb-4 shadow-[0_0_24px_rgba(239,68,68,0.5)]">
              <Shield className="w-12 h-12 text-red-400" />
            </div>
            <h2 className="text-3xl sm:text-4xl font-black text-red-500 mb-2 drop-shadow-[0_0_12px_rgba(239,68,68,0.6)]">
              GAME OVER
            </h2>
            <p className="text-slate-300 text-sm sm:text-base max-w-sm mb-6">
              모든 생명을 잃었습니다. 최종 점수: <b className="text-cyan-400">{score.toLocaleString()}점</b>
            </p>
            <button
              id="retry-game-btn"
              onClick={() => handleStartGame(1)}
              className="flex items-center gap-2 bg-gradient-to-r from-red-600 to-rose-500 hover:from-red-500 hover:to-rose-400 text-white font-bold px-7 py-3 rounded-xl shadow-[0_0_20px_rgba(239,68,68,0.5)] transition-all hover:scale-105"
            >
              <RotateCcw className="w-4 h-4" /> 1단계부터 다시 시작
            </button>
          </div>
        )}

        {/* Modal: Paused */}
        {gameState === 'PAUSED' && (
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center">
            <h3 className="text-2xl font-bold text-cyan-400 mb-4 tracking-widest">일시정지 (PAUSED)</h3>
            <button
              id="resume-btn"
              onClick={() => setGameState('PLAYING')}
              className="flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white font-bold px-6 py-2.5 rounded-xl shadow-[0_0_16px_rgba(6,182,212,0.5)] transition"
            >
              <Play className="w-4 h-4" /> 계속하기
            </button>
          </div>
        )}
      </main>

      {/* Virtual D-pad for Mobile & Touch Controls */}
      <footer className="w-full max-w-4xl mt-3 flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <div className="flex items-center gap-1.5 bg-slate-900/60 px-2.5 py-1.5 rounded-md border border-slate-800">
            <span className="font-semibold text-cyan-400">조작:</span>
            <span>방향키 (▲ ▼ ◄ ►) 또는 WASD</span>
          </div>
          <div className="hidden md:flex items-center gap-1.5 bg-slate-900/60 px-2.5 py-1.5 rounded-md border border-slate-800">
            <span className="font-semibold text-cyan-400">단축키:</span>
            <span>P (일시정지), M (음소거)</span>
          </div>
        </div>

        {/* Mobile On-screen Direction Pad */}
        <div className="flex sm:hidden items-center justify-center gap-2 bg-slate-900/80 border border-slate-800 p-2 rounded-xl">
          <button
            onClick={() => handleVirtualDir('LEFT')}
            className="p-3 bg-slate-800 active:bg-cyan-600 rounded-lg text-slate-200"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => handleVirtualDir('UP')}
              className="p-3 bg-slate-800 active:bg-cyan-600 rounded-lg text-slate-200"
            >
              <ArrowUp className="w-5 h-5" />
            </button>
            <button
              onClick={() => handleVirtualDir('DOWN')}
              className="p-3 bg-slate-800 active:bg-cyan-600 rounded-lg text-slate-200"
            >
              <ArrowDown className="w-5 h-5" />
            </button>
          </div>
          <button
            onClick={() => handleVirtualDir('RIGHT')}
            className="p-3 bg-slate-800 active:bg-cyan-600 rounded-lg text-slate-200"
          >
            <ArrowRight className="w-5 h-5" />
          </button>
        </div>

        <div className="text-xs text-slate-500 font-mono">
          Volfied & Qix Style Canvas Arcade
        </div>
      </footer>

      {/* Guide / How to Play Modal */}
      {showHelp && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-cyan-500/40 rounded-2xl max-w-md w-full p-6 shadow-2xl relative">
            <h3 className="text-xl font-bold text-cyan-400 mb-4 flex items-center gap-2">
              <Gamepad2 className="w-5 h-5" /> 땅따먹기(Qix) 게임 규칙
            </h3>
            <ul className="space-y-3 text-sm text-slate-300">
              <li className="flex items-start gap-2">
                <span className="text-cyan-400 font-bold">•</span>
                <div>
                  <b className="text-white">플레이어 이동:</b> 방향키나 WASD로 녹색 테두리(안전지대)를 따라 자유롭게 이동합니다.
                </div>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-cyan-400 font-bold">•</span>
                <div>
                  <b className="text-cyan-300">영토 개척:</b> 안전지대를 벗어나 검은 미개척 영역으로 나가면 푸른색 선을 그으며 이동합니다.
                </div>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-emerald-400 font-bold">•</span>
                <div>
                  <b className="text-emerald-400">땅 확보:</b> 선을 긋고 다시 안전지대에 닿으면, 선으로 둘러싸여 몬스터가 없는 공간이 내 땅(녹색)으로 바뀝니다!
                </div>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-red-400 font-bold">•</span>
                <div>
                  <b className="text-red-400">주의:</b> 선을 긋는 도중 붉은 몬스터가 플레이어나 그리고 있는 선에 닿으면 생명을 잃습니다.
                </div>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-amber-400 font-bold">•</span>
                <div>
                  <b className="text-amber-400">승리 조건:</b> 전체 면적의 <span className="font-bold text-white">75% 이상</span>을 확보하면 스테이지 클리어!
                </div>
              </li>
            </ul>
            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setShowHelp(false)}
                className="bg-cyan-600 hover:bg-cyan-500 text-white font-bold px-5 py-2 rounded-xl transition text-sm"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Standalone Single-File HTML Export Modal */}
      {showExportModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-cyan-500/40 rounded-2xl max-w-lg w-full p-6 shadow-2xl relative">
            <h3 className="text-xl font-bold text-cyan-400 mb-2 flex items-center gap-2">
              <Download className="w-5 h-5" /> 단일 HTML 파일로 실행하기
            </h3>
            <p className="text-xs text-slate-400 mb-4">
              요청하신 대로 별도 파일 분리 없이 HTML, CSS, JavaScript가 완전히 포함된 1개의 독립 실행형 파일입니다. 다운로드하거나 코드를 복사하여 브라우저에서 바로 더블 클릭해 실행할 수 있습니다.
            </p>

            <div className="flex gap-3 mb-4">
              <button
                id="download-html-file-btn"
                onClick={handleDownloadSingleHtml}
                className="flex-1 flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold py-2.5 rounded-xl transition text-sm shadow-[0_0_14px_rgba(6,182,212,0.4)]"
              >
                <Download className="w-4 h-4" /> qix-land-claim.html 다운로드
              </button>
              <button
                id="copy-html-code-btn"
                onClick={handleCopySingleHtml}
                className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-semibold px-4 py-2.5 rounded-xl transition text-sm"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                <span>{copied ? '복사됨!' : '코드 복사'}</span>
              </button>
            </div>

            <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 text-[11px] font-mono text-slate-400 max-h-44 overflow-y-auto">
              <pre>{getSingleHtmlContent().slice(0, 700)}... (생략)</pre>
            </div>

            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setShowExportModal(false)}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium px-4 py-1.5 rounded-lg transition text-xs"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
