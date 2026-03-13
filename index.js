const mineflayer = require('mineflayer');
const { Movements, pathfinder, goals } = require('mineflayer-pathfinder');
const { GoalBlock, GoalNear } = goals;
const config = require('./settings.json');
const express = require('express');
const http = require('http');

// ============================================================
// EXPRESS SERVER - Keep Render/Aternos alive
// ============================================================
const app = express();
const PORT = process.env.PORT || 5000;

// Bot state tracking
let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: []
};

// ============================================================
// CHAT LOG - stores recent chat messages for the web panel
// ============================================================
const MAX_CHAT_LOG = 100;
let chatLog = []; // { time, username, message, fromConsole }

function addChatLog(username, message, fromConsole = false) {
  chatLog.push({ time: Date.now(), username, message, fromConsole });
  if (chatLog.length > MAX_CHAT_LOG) chatLog.shift();
}

// ============================================================
// HUNT STATE - raid mob hunter
// ============================================================
let huntState = {
  active: false,
  status: 'idle',
  kills: 0,
  itemsCollected: 0,
  currentTarget: null,
  huntInterval: null,
  collectInterval: null,
};

// ============================================================
// GUARD STATE - protect a player
// ============================================================
let guardState = {
  active: false,
  targetPlayer: null,
  guardInterval: null,
  attackPlayers: false,  // attack nearby players when true
};

// Home position
let homePosition = null;

// Sword item names to never drop
const SWORD_NAMES = ['sword', 'axe'];
const HOSTILE_MOBS = ['zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch',
  'pillager', 'vindicator', 'ravager', 'evoker', 'phantom', 'drowned', 'husk',
  'stray', 'blaze', 'ghast', 'slime', 'magma_cube', 'warden', 'hoglin', 'piglin_brute'];

const RAID_MOBS = ['pillager', 'vindicator', 'ravager', 'evoker', 'witch'];

// ============================================================
// AI CHAT - Gemini via OpenAI-compatible API (free tier)
// ============================================================
const { OpenAI } = require('openai');

const aiClient = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/'
});

// Conversation history — persists across messages for memory
let aiHistory = [];
const MAX_AI_HISTORY = 20;

const AI_SYSTEM_PROMPT = `You are a Minecraft player. You are a helpful, talkative teenager who loves Minecraft. You have been playing for years and know a ton about the game — crafting, mobs, biomes, redstone, servers, everything. You are friendly, a little casual, use some gamer slang but keep it readable. You give short snappy replies in Minecraft chat style (under 200 characters when possible since MC chat is limited). Never mention you are an AI. Just be a chill helpful player. If someone asks you to do something you cannot do, say something like "lol i wish i could but idk how to do that rn".`;

// AI cooldown — avoid spamming the API
const AI_COOLDOWN_MS = 3000;
let lastAiCallTime = 0;

// Returns true if a player message should trigger an AI reply
function shouldAiRespond(username, message) {
  if (!bot) return false;
  if (username === bot.username) return false;
  const lower = message.toLowerCase();
  const botName = (bot.username || '').toLowerCase();
  return (
    lower.includes(botName) ||
    lower.startsWith('bot ') ||
    lower.startsWith('bot,') ||
    lower === 'bot' ||
    lower.startsWith('!ai ') ||
    lower.startsWith('!ask ')
  );
}

// Call Gemini and send reply in Minecraft chat
async function handleAiChat(username, message) {
  const now = Date.now();
  if (now - lastAiCallTime < AI_COOLDOWN_MS) return;
  if (!process.env.GEMINI_API_KEY) {
    console.log('[AI] No GEMINI_API_KEY set — skipping');
    return;
  }
  lastAiCallTime = now;

  try {
    // Add player message to history
    aiHistory.push({ role: 'user', content: `${username}: ${message}` });
    if (aiHistory.length > MAX_AI_HISTORY) aiHistory = aiHistory.slice(-MAX_AI_HISTORY);

    const response = await aiClient.chat.completions.create({
      model: 'gemini-2.0-flash',
      messages: [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        ...aiHistory
      ],
      max_tokens: 120,
      temperature: 0.85
    });

    const reply = (response.choices[0].message.content || '').trim();
    if (!reply) return;

    // Add AI reply to history
    aiHistory.push({ role: 'assistant', content: reply });
    if (aiHistory.length > MAX_AI_HISTORY) aiHistory = aiHistory.slice(-MAX_AI_HISTORY);

    // Send in Minecraft (split if over 250 chars)
    if (bot && botState.connected) {
      const chunks = reply.match(/.{1,250}/g) || [reply];
      for (const chunk of chunks) {
        bot.chat(chunk);
        addChatLog(bot.username, chunk, true);
        await new Promise(r => setTimeout(r, 600));
      }
    }
    console.log(`[AI] ${username} -> "${message}" | Reply: "${reply}"`);
  } catch(e) {
    console.log('[AI] Error:', e.message);
  }
}


// Health check endpoint for monitoring
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>${config.name} — Rising Sun</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
        <style>
          *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

          /* ===== RISING SUN THEME ===== */

          body {
            font-family: 'Inter', sans-serif;
            background: #09070f;
            color: #f0e8d0;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: flex-start;
            padding: 28px 16px 60px;
            overflow-x: hidden;
            position: relative;
          }

          /* Diagonal sun ray beams */
          body::before {
            content: '';
            position: fixed; inset: 0;
            background: repeating-linear-gradient(
              118deg,
              transparent 0px, transparent 80px,
              rgba(245,200,60,0.025) 80px, rgba(245,200,60,0.025) 82px
            );
            pointer-events: none; z-index: 0;
            animation: rayDrift 18s linear infinite;
          }
          @keyframes rayDrift {
            0%   { background-position: 0 0; }
            100% { background-position: 200px 200px; }
          }

          /* Horizon warm glow */
          body::after {
            content: '';
            position: fixed;
            bottom: 0; left: 0; right: 0; height: 55%;
            background: radial-gradient(ellipse 120% 60% at 50% 130%,
              rgba(245,180,30,0.1) 0%, rgba(210,100,20,0.06) 40%, transparent 70%);
            pointer-events: none; z-index: 0;
            animation: horizonPulse 7s ease-in-out infinite alternate;
          }
          @keyframes horizonPulse {
            0%   { opacity: 0.6; }
            100% { opacity: 1; }
          }

          /* Floating ember particles */
          .ember {
            position: fixed; bottom: -10px;
            width: 4px; height: 4px; border-radius: 50%;
            background: radial-gradient(circle, #f5c842, #e8830a);
            box-shadow: 0 0 6px #f5c842, 0 0 12px rgba(245,200,60,0.4);
            pointer-events: none; z-index: 0;
            animation: emberRise linear infinite; opacity: 0;
          }
          @keyframes emberRise {
            0%   { transform: translateY(0) translateX(0) scale(1); opacity: 0; }
            10%  { opacity: 0.9; }
            80%  { opacity: 0.4; }
            100% { transform: translateY(-100vh) translateX(40px) scale(0.2); opacity: 0; }
          }

          /* ── CONTAINER ── */
          .container {
            position: relative; z-index: 1;
            width: 100%; max-width: 440px;
            background: linear-gradient(175deg, #111008 0%, #0e0c07 50%, #120e06 100%);
            border-radius: 14px;
            border: 1px solid rgba(245,180,50,0.2);
            box-shadow:
              0 0 0 1px rgba(245,180,50,0.06),
              0 10px 70px rgba(0,0,0,0.7),
              0 0 100px rgba(245,150,20,0.07),
              inset 0 1px 0 rgba(245,200,80,0.07);
            overflow: hidden;
            animation: borderBreathe 6s ease-in-out infinite;
          }
          @keyframes borderBreathe {
            0%,100% { border-color: rgba(245,180,50,0.18); box-shadow: 0 0 0 1px rgba(245,180,50,0.05), 0 10px 70px rgba(0,0,0,0.7), 0 0 80px rgba(245,150,20,0.06), inset 0 1px 0 rgba(245,200,80,0.06); }
            50%     { border-color: rgba(245,200,80,0.38); box-shadow: 0 0 0 1px rgba(245,180,50,0.1), 0 10px 70px rgba(0,0,0,0.7), 0 0 120px rgba(245,180,30,0.13), inset 0 1px 0 rgba(245,200,80,0.1); }
          }

          /* Gold shimmer sweep */
          .container::before {
            content: '';
            position: absolute; top: 0; left: -100%;
            width: 100%; height: 1px;
            background: linear-gradient(90deg, transparent, rgba(245,180,50,0.5), rgba(255,240,150,0.95), rgba(245,180,50,0.5), transparent);
            animation: goldSweep 7s ease-in-out infinite;
            z-index: 10;
          }
          @keyframes goldSweep {
            0%,15% { left: -100%; opacity: 0; }
            20%    { opacity: 1; }
            80%    { opacity: 1; }
            100%   { left: 100%; opacity: 0; }
          }

          /* Bottom horizon glow line */
          .container::after {
            content: '';
            position: absolute; bottom: 0; left: 0; right: 0; height: 1px;
            background: linear-gradient(90deg, transparent, rgba(245,180,50,0.4), rgba(245,180,50,0.6), rgba(245,180,50,0.4), transparent);
          }

          /* ── HEADER ── */
          .header {
            padding: 22px 22px 20px;
            display: flex; align-items: center; gap: 14px;
            background: linear-gradient(135deg, rgba(245,180,50,0.09) 0%, transparent 60%);
            position: relative;
          }
          .header::after {
            content: '';
            position: absolute; bottom: 0; left: 0; right: 0; height: 1px;
            background: linear-gradient(90deg, rgba(245,180,50,0.5), rgba(210,120,20,0.3), transparent);
          }
          .bot-icon {
            width: 48px; height: 48px; border-radius: 12px; flex-shrink: 0;
            background: linear-gradient(135deg, rgba(245,180,50,0.15), rgba(210,100,20,0.15));
            border: 1px solid rgba(245,180,50,0.35);
            display: flex; align-items: center; justify-content: center; font-size: 24px;
            box-shadow: 0 0 24px rgba(245,180,50,0.18), inset 0 1px 0 rgba(255,240,150,0.12);
            position: relative; overflow: hidden;
          }
          .bot-icon::after {
            content: '';
            position: absolute; top: -50%; left: -60%;
            width: 40%; height: 200%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent);
            transform: skewX(-20deg);
            animation: iconShine 4s ease-in-out infinite;
          }
          @keyframes iconShine {
            0%,100% { left: -60%; opacity: 0; }
            40%     { opacity: 1; }
            50%     { left: 130%; opacity: 0; }
          }
          .header-text { flex: 1; overflow: hidden; }
          .bot-name {
            font-family: 'Cinzel', serif;
            font-size: 16px; font-weight: 700; color: #fff;
            letter-spacing: 2px; text-transform: uppercase;
            text-shadow: 0 0 24px rgba(245,200,80,0.55), 0 1px 0 rgba(0,0,0,0.5);
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          }
          .bot-sub {
            font-size: 9px; color: rgba(245,180,50,0.55);
            letter-spacing: 3.5px; text-transform: uppercase;
            font-family: 'JetBrains Mono', monospace; margin-top: 3px;
          }
          #live-indicator {
            width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
            background: radial-gradient(circle, #ffe066, #f5a820);
            box-shadow: 0 0 10px #f5c842, 0 0 22px rgba(245,200,60,0.45);
            animation: sunPulse 2.4s ease-in-out infinite;
          }
          @keyframes sunPulse {
            0%,100% { transform: scale(1);    box-shadow: 0 0 8px #f5c842,  0 0 18px rgba(245,200,60,0.4); }
            40%     { transform: scale(1.4);  box-shadow: 0 0 18px #f5c842, 0 0 38px rgba(245,200,60,0.65); }
            60%     { transform: scale(1.15); box-shadow: 0 0 12px #f5c842, 0 0 26px rgba(245,200,60,0.5); }
          }

          /* ── STATS GRID ── */
          .stats-grid {
            display: grid; grid-template-columns: 1fr 1fr;
            gap: 1px; background: rgba(245,180,50,0.07);
          }
          .stat-card {
            background: rgba(9,7,4,0.92);
            padding: 15px 18px;
            position: relative; overflow: hidden;
            transition: background 0.25s; cursor: default;
          }
          .stat-card:hover { background: rgba(245,180,50,0.05); }
          .stat-card::after {
            content: '';
            position: absolute; top: 0; left: -100%;
            width: 60%; height: 100%;
            background: linear-gradient(90deg, transparent, rgba(245,200,80,0.04), transparent);
            transform: skewX(-15deg);
            transition: left 0.5s ease;
          }
          .stat-card:hover::after { left: 160%; }
          .stat-card::before {
            content: '';
            position: absolute; top: 0; left: 0;
            width: 3px; height: 100%;
            background: linear-gradient(180deg, #f5c842, rgba(210,120,20,0.4), transparent);
          }
          .stat-card.full { grid-column: 1 / -1; }
          .label {
            font-size: 9.5px; color: rgba(245,180,50,0.55);
            text-transform: uppercase; letter-spacing: 2.5px;
            font-family: 'JetBrains Mono', monospace; margin-bottom: 5px;
          }
          .value {
            font-size: 15px; font-weight: 700; color: #ffffff;
            font-family: 'JetBrains Mono', monospace;
            text-shadow: 0 0 12px rgba(245,200,80,0.2);
          }

          /* ── PANELS ── */
          .panel { border-top: 1px solid rgba(245,180,50,0.09); overflow: hidden; }
          .panel-header {
            padding: 11px 18px;
            display: flex; align-items: center; justify-content: space-between;
            background: linear-gradient(90deg, rgba(245,180,50,0.07), transparent 70%);
            border-bottom: 1px solid rgba(245,180,50,0.07);
          }
          .panel-title {
            font-family: 'Cinzel', serif;
            font-size: 11px; font-weight: 600; letter-spacing: 2.5px;
            text-transform: uppercase; color: rgba(245,200,100,0.9);
            display: flex; align-items: center; gap: 8px;
          }
          .panel-title::before { content: '✦'; color: #f5c842; font-size: 10px; }
          .badge {
            font-size: 9px; font-weight: 700; letter-spacing: 1px;
            padding: 3px 10px; border-radius: 99px;
            background: rgba(245,180,50,0.07);
            color: rgba(245,180,50,0.35);
            border: 1px solid rgba(245,180,50,0.15);
            font-family: 'JetBrains Mono', monospace;
            transition: all 0.3s;
          }
          .badge.on {
            background: rgba(245,180,50,0.18); color: #f5c842;
            border-color: rgba(245,200,80,0.5);
            animation: badgeSun 2.5s ease-in-out infinite;
          }
          @keyframes badgeSun {
            0%,100% { box-shadow: 0 0 10px rgba(245,200,60,0.3); }
            50%     { box-shadow: 0 0 22px rgba(245,200,60,0.6), 0 0 6px rgba(255,240,120,0.4); }
          }
          .panel-body { padding: 14px; display: flex; flex-direction: column; gap: 10px; }

          /* ── CHAT ── */
          .chat-log {
            height: 130px; overflow-y: auto;
            padding: 10px 16px;
            display: flex; flex-direction: column; gap: 4px;
            background: rgba(6,4,2,0.7);
          }
          .chat-log::-webkit-scrollbar { width: 3px; }
          .chat-log::-webkit-scrollbar-thumb { background: rgba(245,180,50,0.25); border-radius: 3px; }
          .cmsg {
            font-size: 12.5px; line-height: 1.55; color: #d8cdb8;
            word-break: break-word; font-family: 'JetBrains Mono', monospace;
          }
          .cmsg .cname { font-weight: 600; margin-right: 5px; }
          .cmsg.mine  .cname { color: #ffd166; }
          .cmsg.other .cname { color: #e8a44a; }
          .no-msg {
            color: rgba(245,180,50,0.22); font-size: 12px; text-align: center;
            padding: 35px 0; font-style: italic; font-family: 'JetBrains Mono', monospace;
          }
          .chat-input-row { display: flex; border-top: 1px solid rgba(245,180,50,0.09); }
          .chat-input-row input {
            flex: 1; background: transparent; border: none; outline: none;
            color: #f0e0b0; padding: 11px 16px; font-size: 13px;
            font-family: 'JetBrains Mono', monospace;
          }
          .chat-input-row input::placeholder { color: rgba(245,180,50,0.22); }
          .btn-send {
            background: linear-gradient(135deg, rgba(245,180,50,0.22), rgba(210,100,20,0.18));
            border: none; border-left: 1px solid rgba(245,180,50,0.18);
            color: #f5c842; padding: 11px 18px; font-weight: 700; font-size: 12px;
            cursor: pointer; transition: all 0.2s; white-space: nowrap;
            letter-spacing: 1px; font-family: 'Inter', sans-serif;
          }
          .btn-send:hover { background: linear-gradient(135deg, rgba(245,180,50,0.38), rgba(210,100,20,0.3)); color: #fff; }
          .btn-send:disabled { opacity: 0.25; cursor: not-allowed; }
          #chat-feedback {
            font-size: 10px; padding: 3px 16px; color: #e8830a; min-height: 18px;
            font-family: 'JetBrains Mono', monospace;
          }

          /* ── BUTTONS ── */
          .act-row { display: flex; gap: 8px; }
          .act-btn {
            flex: 1; padding: 10px 8px; border-radius: 8px;
            font-size: 12px; font-weight: 600; cursor: pointer;
            transition: all 0.2s; font-family: 'Inter', sans-serif;
            position: relative; overflow: hidden; letter-spacing: 0.4px;
          }
          .act-btn::before {
            content: '';
            position: absolute; top: 50%; left: 50%;
            width: 0; height: 0; border-radius: 50%;
            background: rgba(245,200,80,0.2);
            transform: translate(-50%,-50%);
            transition: width 0.45s ease, height 0.45s ease, opacity 0.45s ease;
            opacity: 1;
          }
          .act-btn:active:not(:disabled)::before { width: 280px; height: 280px; opacity: 0; }
          .act-btn:disabled { opacity: 0.28; cursor: not-allowed; }

          .btn-gold {
            background: linear-gradient(135deg, rgba(245,180,50,0.18), rgba(210,120,20,0.12));
            color: #f5c842; border: 1px solid rgba(245,180,50,0.38);
          }
          .btn-gold:hover:not(:disabled) {
            background: linear-gradient(135deg, rgba(245,180,50,0.32), rgba(210,120,20,0.22));
            color: #fff; border-color: rgba(245,200,80,0.65);
            box-shadow: 0 0 18px rgba(245,180,50,0.28), 0 2px 8px rgba(0,0,0,0.3);
            transform: translateY(-1px);
          }
          .btn-muted {
            background: rgba(255,255,255,0.04);
            color: rgba(200,185,150,0.65); border: 1px solid rgba(255,255,255,0.08);
          }
          .btn-muted:hover:not(:disabled) {
            background: rgba(245,180,50,0.09); color: #f0d898;
            border-color: rgba(245,180,50,0.25);
          }
          .btn-amber {
            background: linear-gradient(135deg, rgba(210,120,20,0.2), rgba(180,80,10,0.14));
            color: #e8a44a; border: 1px solid rgba(210,120,20,0.38);
          }
          .btn-amber:hover:not(:disabled) {
            background: linear-gradient(135deg, rgba(210,120,20,0.34), rgba(180,80,10,0.24));
            color: #fff; border-color: rgba(210,140,40,0.65);
            box-shadow: 0 0 16px rgba(210,120,20,0.28);
            transform: translateY(-1px);
          }
          .btn-dawn {
            background: linear-gradient(135deg, rgba(255,240,180,0.12), rgba(245,200,80,0.08));
            color: #fff8e0; border: 1px solid rgba(255,240,180,0.25);
          }
          .btn-dawn:hover:not(:disabled) {
            background: linear-gradient(135deg, rgba(255,240,180,0.24), rgba(245,200,80,0.16));
            color: #fff; border-color: rgba(255,240,180,0.5);
            box-shadow: 0 0 18px rgba(255,240,150,0.2);
            transform: translateY(-1px);
          }
          .btn-flame {
            background: linear-gradient(135deg, rgba(220,80,20,0.2), rgba(180,40,10,0.14));
            color: #ff9955; border: 1px solid rgba(220,80,20,0.38);
          }
          .btn-flame:hover:not(:disabled) {
            background: linear-gradient(135deg, rgba(220,80,20,0.34), rgba(180,40,10,0.24));
            color: #fff; border-color: rgba(220,100,40,0.65);
            box-shadow: 0 0 16px rgba(220,80,20,0.3);
            transform: translateY(-1px);
          }

          /* ── HUNT STATS ── */
          .hunt-stats { display: flex; gap: 8px; }
          .hstat {
            flex: 1; text-align: center; padding: 12px 6px;
            background: rgba(245,180,50,0.05);
            border: 1px solid rgba(245,180,50,0.14); border-radius: 10px;
            transition: background 0.2s, border-color 0.2s;
          }
          .hstat:hover { background: rgba(245,180,50,0.09); border-color: rgba(245,180,50,0.25); }
          .hstat .hl {
            font-size: 9px; color: rgba(245,180,50,0.5);
            text-transform: uppercase; letter-spacing: 1.5px;
            font-family: 'JetBrains Mono', monospace; margin-bottom: 5px;
          }
          .hstat .hv {
            font-size: 22px; font-weight: 700; color: #ffffff;
            font-family: 'JetBrains Mono', monospace;
            text-shadow: 0 0 14px rgba(245,200,80,0.4);
          }

          /* ── SELECT ── */
          .sun-select {
            width: 100%;
            background: rgba(6,4,2,0.8);
            border: 1px solid rgba(245,180,50,0.22);
            color: #f0e0b0; padding: 10px 36px 10px 14px; border-radius: 8px;
            font-size: 13px; outline: none;
            font-family: 'JetBrains Mono', monospace;
            transition: border-color 0.2s, box-shadow 0.2s;
            appearance: none;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23f5c842' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
            background-repeat: no-repeat;
            background-position: right 14px center;
          }
          .sun-select:focus { border-color: rgba(245,200,80,0.55); box-shadow: 0 0 0 3px rgba(245,180,50,0.08); }
          .sun-select option { background: #111008; color: #f0e0b0; }

          /* ── INFO ROW ── */
          .info-row {
            font-size: 11px; color: rgba(245,180,50,0.45); text-align: center;
            font-family: 'JetBrains Mono', monospace; padding: 2px 0;
          }
          .info-row span { color: #e8a44a; font-weight: 600; }

          /* ── STAR DIVIDER ── */
          .star-divider {
            display: flex; align-items: center; gap: 10px;
            font-size: 11px; color: rgba(245,180,50,0.3); padding: 2px 0;
          }
          .star-divider::before, .star-divider::after {
            content: ''; flex: 1; height: 1px;
            background: linear-gradient(90deg, transparent, rgba(245,180,50,0.2), transparent);
          }

          /* ── FOOTER ── */
          .sun-footer {
            padding: 14px; text-align: center;
            font-family: 'Cinzel', serif;
            font-size: 11px; letter-spacing: 3px; color: rgba(245,180,50,0.3);
            border-top: 1px solid rgba(245,180,50,0.07);
          }
        </style>
      </head>
      <body>

        <div class="ember" style="left:8%;  animation-duration:11s; animation-delay:0s;"></div>
        <div class="ember" style="left:22%; animation-duration:15s; animation-delay:2s;"></div>
        <div class="ember" style="left:40%; animation-duration:9s;  animation-delay:4s;"></div>
        <div class="ember" style="left:58%; animation-duration:13s; animation-delay:1s;"></div>
        <div class="ember" style="left:74%; animation-duration:10s; animation-delay:3.5s;"></div>
        <div class="ember" style="left:90%; animation-duration:12s; animation-delay:6s;"></div>

        <div class="container" id="main-container">

          <div class="header">
            <div class="bot-icon">☀️</div>
            <div class="header-text">
              <div class="bot-name">${config.name}</div>
              <div class="bot-sub">Guardian of the Dawn</div>
            </div>
            <div id="live-indicator"></div>
          </div>

          <div class="stats-grid">
            <div class="stat-card full">
              <div class="label">Status</div>
              <div class="value" id="status-text">Connecting...</div>
            </div>
            <div class="stat-card">
              <div class="label">Uptime</div>
              <div class="value" id="uptime-text">0h 0m 0s</div>
            </div>
            <div class="stat-card">
              <div class="label">Coordinates</div>
              <div class="value" id="coords-text">—</div>
            </div>
            <div class="stat-card full">
              <div class="label">Server</div>
              <div class="value">${config.server.ip}</div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-header">
              <span class="panel-title">Server Chat</span>
            </div>
            <div class="chat-log" id="chat-log-mini">
              <div class="no-msg">Awaiting the first light...</div>
            </div>
            <div id="chat-feedback"></div>
            <div class="chat-input-row">
              <input id="chat-input" type="text" placeholder="Send a message as bot..." maxlength="256" />
              <button class="btn-send" id="chat-send-btn" disabled>SEND</button>
            </div>
          </div>

          <div class="panel">
            <div class="panel-header">
              <span class="panel-title">Activities</span>
              <span class="badge" id="hunt-badge">IDLE</span>
            </div>
            <div class="panel-body">
              <div class="hunt-stats">
                <div class="hstat"><div class="hl">Kills</div><div class="hv" id="hunt-kills">0</div></div>
                <div class="hstat"><div class="hl">Items</div><div class="hv" id="hunt-items">0</div></div>
                <div class="hstat"><div class="hl">Mode</div><div class="hv" id="hunt-mode" style="font-size:12px;">—</div></div>
              </div>
              <div class="act-row">
                <button class="act-btn btn-gold"  id="btn-hunt-start" disabled>⚔️ Start Hunt</button>
                <button class="act-btn btn-muted" id="btn-hunt-stop"  disabled>■ Stop</button>
              </div>
              <div class="star-divider">✦</div>
              <div class="info-row" id="home-pos-display">Home: <span>Not Set</span></div>
              <div class="act-row">
                <button class="act-btn btn-amber" id="btn-set-home"    disabled>📍 Set Home</button>
                <button class="act-btn btn-amber" id="btn-drop-return" disabled>📦 Drop &amp; Return</button>
              </div>
              <div class="act-row">
                <button class="act-btn btn-dawn" id="btn-equip-sword" disabled>🗡️ Equip Sword</button>
              </div>
              <div class="act-row">
                <button class="act-btn btn-dawn" id="btn-equip-armor" disabled>🛡 Equip Best Armor</button>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-header">
              <span class="panel-title">Guard Mode</span>
              <span class="badge" id="guard-badge">OFF</span>
            </div>
            <div class="panel-body">
              <div class="info-row" id="guard-target-display">Guarding: <span>Nobody</span></div>
              <select class="sun-select" id="guard-player-select">
                <option value="">— Select a player to guard —</option>
              </select>
              <div class="act-row">
                <button class="act-btn btn-gold"  id="btn-guard-start" disabled>🛡️ Start Guard</button>
                <button class="act-btn btn-muted" id="btn-guard-stop"  disabled>■ Stop</button>
              </div>
              <div class="star-divider">✦</div>
              <div class="act-row">
                <button class="act-btn btn-flame" id="btn-atk-start" disabled>⚔️ Attack Nearby Players</button>
                <button class="act-btn btn-muted" id="btn-atk-stop"  disabled>■ Stop</button>
              </div>
            </div>
          </div>

          <div class="sun-footer">✦ &nbsp; RISING SUN BOT &nbsp; ✦</div>
        </div>

        <script>
          const formatUptime = (s) => {
            const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
            return \`\${h}h \${m}m \${sec}s\`;
          };
          function escHtml(t) {
            return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          }

          let lastChatCount = 0;
          let isConnected = false;

          const updateStats = async () => {
            try {
              const res  = await fetch('/health');
              const data = await res.json();
              const statusText = document.getElementById('status-text');
              const uptimeText = document.getElementById('uptime-text');
              const coordsText = document.getElementById('coords-text');
              const indicator  = document.getElementById('live-indicator');
              const sendBtn    = document.getElementById('chat-send-btn');

              isConnected = data.status === 'connected';
              sendBtn.disabled = !isConnected;

              if (isConnected) {
                statusText.textContent = '✦ Online & Running';
                statusText.style.color = '#f5c842';
                indicator.style.background = 'radial-gradient(circle, #ffe066, #f5a820)';
                indicator.style.boxShadow  = '0 0 10px #f5c842, 0 0 22px rgba(245,200,60,0.45)';
              } else {
                statusText.textContent = '○ Reconnecting...';
                statusText.style.color = 'rgba(245,180,50,0.45)';
                indicator.style.background = 'rgba(245,180,50,0.25)';
                indicator.style.boxShadow  = 'none';
              }

              uptimeText.textContent = formatUptime(data.uptime);
              coordsText.textContent = data.coords
                ? \`\${Math.floor(data.coords.x)}, \${Math.floor(data.coords.y)}, \${Math.floor(data.coords.z)}\`
                : '—';
            } catch(e) {
              document.getElementById('status-text').textContent = '✕ Offline';
              document.getElementById('status-text').style.color = '#e8830a';
            }
          };

          const updateChat = async () => {
            try {
              const res = await fetch('/chat-log');
              const { log } = await res.json();
              if (log.length === lastChatCount) return;
              lastChatCount = log.length;
              const box = document.getElementById('chat-log-mini');
              const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 50;
              if (log.length === 0) {
                box.innerHTML = '<div class="no-msg">No messages yet.</div>';
              } else {
                box.innerHTML = log.slice(-30).map(m => \`
                  <div class="cmsg \${m.fromConsole ? 'mine' : 'other'}">
                    <span class="cname">\${escHtml(m.username)}:</span>\${escHtml(m.message)}
                  </div>
                \`).join('');
              }
              if (atBottom) box.scrollTop = box.scrollHeight;
            } catch(e) {}
          };

          async function sendChat() {
            const input = document.getElementById('chat-input');
            const feedback = document.getElementById('chat-feedback');
            const msg = input.value.trim();
            if (!msg || !isConnected) return;
            input.value = ''; feedback.textContent = '';
            document.getElementById('chat-send-btn').disabled = true;
            try {
              const res  = await fetch('/send-chat', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: msg })
              });
              const data = await res.json();
              if (!data.ok) feedback.textContent = 'Error: ' + data.error;
              else { await updateChat(); document.getElementById('chat-log-mini').scrollTop = 9999; }
            } catch(e) { feedback.textContent = 'Request failed.'; }
            document.getElementById('chat-send-btn').disabled = !isConnected;
            input.focus();
          }

          document.getElementById('chat-send-btn').addEventListener('click', sendChat);
          document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

          setInterval(updateStats, 1000);
          setInterval(updateChat, 1500);
          setInterval(updateHunt, 1500);
          updateStats(); updateChat(); updateHunt();

          async function updateHunt() {
            try {
              const res = await fetch('/hunt-status');
              const d   = await res.json();
              document.getElementById('hunt-kills').textContent = d.kills;
              document.getElementById('hunt-items').textContent = d.itemsCollected;
              const modeLabels = { idle:'Idle', hunting:'⚔️ Hunt', collecting:'📦 Loot', returning:'🏠 Home' };
              document.getElementById('hunt-mode').textContent = modeLabels[d.status] || d.status;
              const badge = document.getElementById('hunt-badge');
              badge.textContent = d.active ? d.status.toUpperCase() : 'IDLE';
              badge.className   = 'badge' + (d.active ? ' on' : '');
              const homeDisp = document.getElementById('home-pos-display');
              if (d.homePosition) {
                const h = d.homePosition;
                homeDisp.innerHTML = \`Home: <span>\${h.x}, \${h.y}, \${h.z}</span>\`;
              } else {
                homeDisp.innerHTML = 'Home: <span>Not Set</span>';
              }
              document.getElementById('btn-hunt-start').disabled  = !isConnected || d.active;
              document.getElementById('btn-hunt-stop').disabled   = !isConnected || !d.active;
              document.getElementById('btn-set-home').disabled    = !isConnected;
              document.getElementById('btn-drop-return').disabled = !isConnected;
              document.getElementById('btn-equip-armor').disabled = !isConnected;
            } catch(e) {}
          }

          async function huntAction(endpoint) {
            try {
              const res = await fetch(endpoint, { method:'POST', headers:{'Content-Type':'application/json'} });
              const d   = await res.json();
              if (!d.ok) alert('Error: ' + d.error);
              else await updateHunt();
            } catch(e) { alert('Request failed'); }
          }

          document.getElementById('btn-hunt-start').addEventListener('click',  () => huntAction('/hunt/start'));
          document.getElementById('btn-hunt-stop').addEventListener('click',   () => huntAction('/hunt/stop'));
          document.getElementById('btn-set-home').addEventListener('click',    () => huntAction('/hunt/set-home'));
          document.getElementById('btn-drop-return').addEventListener('click', () => huntAction('/hunt/drop-and-return'));
          document.getElementById('btn-equip-sword').addEventListener('click', async () => {
            try {
              const res = await fetch('/equip-sword', { method:'POST' });
              const d   = await res.json();
              if (!d.ok) alert('Equip failed: ' + d.error);
            } catch(e) { alert('Request failed'); }
          });

          document.getElementById('btn-equip-armor').addEventListener('click', async () => {
            const btn = document.getElementById('btn-equip-armor');
            btn.textContent = '⏳ Equipping...';
            btn.disabled = true;
            try {
              const res = await fetch('/equip-armor', { method:'POST' });
              const d   = await res.json();
              if (!d.ok) {
                alert('Armor equip failed: ' + d.error);
              } else {
                const names = d.equipped.map(e => e.name.replace(/_/g,' ')).join(', ');
                btn.textContent = '✦ Equipped!';
                setTimeout(() => { btn.textContent = '🛡 Equip Best Armor'; btn.disabled = !isConnected; }, 2000);
                console.log('[Armor] Equipped:', names);
                return;
              }
            } catch(e) { alert('Request failed'); }
            btn.textContent = '🛡 Equip Best Armor';
            btn.disabled = !isConnected;
          });

          let guardActive = false;
          async function updateGuard() {
            try {
              const res = await fetch('/guard-status');
              const d   = await res.json();
              guardActive = d.active;
              const badge      = document.getElementById('guard-badge');
              const targetDisp = document.getElementById('guard-target-display');
              badge.textContent = d.active ? (d.attackPlayers ? 'ATTACKING' : 'ACTIVE') : 'OFF';
              badge.className   = 'badge' + (d.active ? ' on' : '');
              targetDisp.innerHTML = d.active && d.targetPlayer
                ? \`Guarding: <span>\${escHtml(d.targetPlayer)}</span>\`
                : 'Guarding: <span>Nobody</span>';
              document.getElementById('btn-guard-start').disabled = !isConnected || d.active;
              document.getElementById('btn-guard-stop').disabled  = !isConnected || !d.active;
              document.getElementById('btn-atk-start').disabled   = !isConnected || !d.active || d.attackPlayers;
              document.getElementById('btn-atk-stop').disabled    = !isConnected || !d.attackPlayers;
              document.getElementById('btn-equip-sword').disabled = !isConnected;
              document.getElementById('btn-equip-armor').disabled = !isConnected;
              const sel = document.getElementById('guard-player-select');
              const current = sel.value;
              const pRes = await fetch('/players');
              const { players } = await pRes.json();
              sel.innerHTML = '<option value="">— Select a player to guard —</option>' +
                players.map(p => \`<option value="\${escHtml(p)}" \${p===current?'selected':''}>\${escHtml(p)}</option>\`).join('');
            } catch(e) {}
          }

          document.getElementById('btn-guard-start').addEventListener('click', async () => {
            const player = document.getElementById('guard-player-select').value;
            if (!player) return alert('Select a player first');
            try {
              const res = await fetch('/guard/start', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ player })
              });
              const d = await res.json();
              if (!d.ok) alert('Error: ' + d.error);
              else updateGuard();
            } catch(e) { alert('Request failed'); }
          });

          document.getElementById('btn-guard-stop').addEventListener('click', async () => {
            try { await fetch('/guard/stop', { method:'POST' }); updateGuard(); } catch(e) {}
          });

          document.getElementById('btn-atk-start').addEventListener('click', async () => {
            try {
              const res = await fetch('/guard/attack-players/start', { method:'POST' });
              const d   = await res.json();
              if (!d.ok) alert('Error: ' + d.error);
              else updateGuard();
            } catch(e) { alert('Request failed'); }
          });

          document.getElementById('btn-atk-stop').addEventListener('click', async () => {
            try { await fetch('/guard/attack-players/stop', { method:'POST' }); updateGuard(); } catch(e) {}
          });

          setInterval(updateGuard, 2000);
          updateGuard();
        </script>
      </body>
    </html>
  `);
});

app.get('/tutorial', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>${config.name} - Setup Guide</title>
        <style>
          body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #cbd5e1; padding: 40px; max-width: 800px; margin: 0 auto; line-height: 1.6; }
          h1, h2 { color: #2dd4bf; }
          h1 { border-bottom: 2px solid #334155; padding-bottom: 10px; }
          .card { background: #1e293b; padding: 25px; border-radius: 12px; margin-bottom: 20px; border: 1px solid #334155; }
          a { color: #38bdf8; text-decoration: none; }
          code { background: #334155; padding: 2px 6px; border-radius: 4px; color: #e2e8f0; font-family: monospace; }
          .btn-home { display: inline-block; margin-bottom: 20px; padding: 8px 16px; background: #334155; color: white; border-radius: 6px; text-decoration: none; }
        </style>
      </head>
      <body>
        <a href="/" class="btn-home">Back to Dashboard</a>
        <h1>Setup Guide (Under 15 Minutes)</h1>
        
        <div class="card">
          <h2>Step 1: Configure Aternos</h2>
          <ol>
            <li>Go to <strong>Aternos</strong>.</li>
            <li>Install <strong>Paper/Bukkit</strong> software.</li>
            <li>Enable <strong>Cracked</strong> mode (Green Switch).</li>
            <li>Install Plugins: <code>ViaVersion</code>, <code>ViaBackwards</code>, <code>ViaRewind</code>.</li>
          </ol>
        </div>

        <div class="card">
          <h2>Step 2: GitHub Setup</h2>
          <ol>
            <li>Download this code as ZIP and extract.</li>
            <li>Edit <code>settings.json</code> with your IP/Port.</li>
            <li>Upload all files to a new <strong>GitHub Repository</strong>.</li>
          </ol>
        </div>

        <div class="card">
          <h2>Step 3: Render (Free 24/7 Hosting)</h2>
          <ol>
            <li>Go to <a href="https://render.com" target="_blank">Render.com</a> and create a Web Service.</li>
            <li>Connect your GitHub.</li>
            <li>Build Command: <code>npm install</code></li>
            <li>Start Command: <code>npm start</code></li>
            <li><strong>Magic:</strong> The bot automatically pings itself to stay awake!</li>
          </ol>
        </div>
        
        <p style="text-align: center; margin-top: 40px; color: #64748b;">AFK Bot Dashboard</p>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({
    status: botState.connected ? 'connected' : 'disconnected',
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: (bot && bot.entity) ? bot.entity.position : null,
    lastActivity: botState.lastActivity,
    reconnectAttempts: botState.reconnectAttempts,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024
  });
});

app.get('/ping', (req, res) => res.send('pong'));

// ============================================================
// CHAT API - Send message as bot & get chat log
// ============================================================
app.use(express.json());

// POST /send-chat  { "message": "hello world" }
app.post('/send-chat', (req, res) => {
  const msg = (req.body && req.body.message || '').trim();
  if (!msg) return res.json({ ok: false, error: 'Empty message' });
  if (!bot || !botState.connected) return res.json({ ok: false, error: 'Bot not connected' });

  try {
    bot.chat(msg);
    addChatLog(config['bot-account'].username + ' [YOU]', msg, true);
    console.log(`[Chat→MC] ${msg}`);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /chat-log  returns recent chat messages as JSON
app.get('/chat-log', (req, res) => {
  res.json({ log: chatLog });
});

// ============================================================
// HUNT & HOME API ENDPOINTS
// ============================================================

// GET /hunt-status
app.get('/hunt-status', (req, res) => {
  res.json({
    active: huntState.active,
    status: huntState.status,
    kills: huntState.kills,
    itemsCollected: huntState.itemsCollected,
    currentTarget: huntState.currentTarget,
    homePosition: homePosition
  });
});

// POST /hunt/start
app.post('/hunt/start', (req, res) => {
  if (!bot || !botState.connected) return res.json({ ok: false, error: 'Bot not connected' });
  if (huntState.active) return res.json({ ok: false, error: 'Hunt already active' });
  startHuntMode();
  res.json({ ok: true });
});

// POST /hunt/stop
app.post('/hunt/stop', (req, res) => {
  stopHuntMode();
  res.json({ ok: true });
});

// POST /hunt/set-home  — sets home to bot's current position
app.post('/hunt/set-home', (req, res) => {
  if (!bot || !botState.connected) return res.json({ ok: false, error: 'Bot not connected' });
  const pos = bot.entity.position;
  homePosition = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
  console.log(`[Hunt] Home set to ${homePosition.x}, ${homePosition.y}, ${homePosition.z}`);
  res.json({ ok: true, home: homePosition });
});

// POST /hunt/drop-and-return — drop all items then go home
app.post('/hunt/drop-and-return', (req, res) => {
  if (!bot || !botState.connected) return res.json({ ok: false, error: 'Bot not connected' });
  dropAllAndReturn();
  res.json({ ok: true });
});

// ============================================================
// SWORD & GUARD API ENDPOINTS
// ============================================================

// GET /players — list of online players (excluding the bot)
app.get('/players', (req, res) => {
  if (!bot || !botState.connected) return res.json({ players: [] });
  try {
    const players = Object.values(bot.players)
      .map(p => p.username)
      .filter(n => n && n !== bot.username);
    res.json({ players });
  } catch(e) {
    res.json({ players: [] });
  }
});

// POST /equip-sword — equip best sword from inventory into main hand
app.post('/equip-sword', async (req, res) => {
  if (!bot || !botState.connected) return res.json({ ok: false, error: 'Bot not connected' });
  try {
    const sword = bot.inventory.items().find(i =>
      SWORD_NAMES.some(s => i.name.toLowerCase().includes(s))
    );
    if (!sword) return res.json({ ok: false, error: 'No sword in inventory' });
    await bot.equip(sword, 'hand');
    console.log(`[Sword] Equipped ${sword.name}`);
    res.json({ ok: true, sword: sword.name });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /equip-armor — equip best available armor per slot
// Priority: diamond > iron > chainmail > golden > leather
app.post('/equip-armor', async (req, res) => {
  if (!bot || !botState.connected) return res.json({ ok: false, error: 'Bot not connected' });

  const ARMOR_PRIORITY = ['diamond', 'iron', 'chainmail', 'golden', 'leather'];
  const ARMOR_SLOTS = [
    { slot: 'head',  suffixes: ['_helmet'] },
    { slot: 'torso', suffixes: ['_chestplate'] },
    { slot: 'legs',  suffixes: ['_leggings'] },
    { slot: 'feet',  suffixes: ['_boots'] },
  ];

  const equipped = [];
  const failed   = [];

  for (const { slot, suffixes } of ARMOR_SLOTS) {
    let best = null;
    let bestTier = Infinity;

    for (const item of bot.inventory.items()) {
      const name = item.name.toLowerCase();
      const matchesSuffix = suffixes.some(s => name.endsWith(s));
      if (!matchesSuffix) continue;

      const tier = ARMOR_PRIORITY.findIndex(t => name.startsWith(t));
      if (tier !== -1 && tier < bestTier) {
        best = item;
        bestTier = tier;
      }
    }

    if (best) {
      try {
        await bot.equip(best, slot);
        console.log(`[Armor] Equipped ${best.name} on ${slot}`);
        equipped.push({ slot, name: best.name });
        await new Promise(r => setTimeout(r, 150)); // small delay between slots
      } catch(e) {
        console.log(`[Armor] Failed ${slot}: ${e.message}`);
        failed.push({ slot, error: e.message });
      }
    } else {
      console.log(`[Armor] No armor found for ${slot}`);
    }
  }

  if (equipped.length === 0) {
    return res.json({ ok: false, error: 'No armor found in inventory' });
  }
  res.json({ ok: true, equipped, failed });
});

// GET /guard-status
app.get('/guard-status', (req, res) => {
  res.json({
    active: guardState.active,
    targetPlayer: guardState.targetPlayer,
    attackPlayers: guardState.attackPlayers
  });
});

// POST /guard/start  { "player": "username" }
app.post('/guard/start', (req, res) => {
  if (!bot || !botState.connected) return res.json({ ok: false, error: 'Bot not connected' });
  const player = req.body && req.body.player;
  if (!player) return res.json({ ok: false, error: 'No player specified' });
  startGuardMode(player);
  res.json({ ok: true });
});

// POST /guard/stop
app.post('/guard/stop', (req, res) => {
  stopGuardMode();
  res.json({ ok: true });
});

// POST /guard/attack-players/start
app.post('/guard/attack-players/start', (req, res) => {
  if (!bot || !botState.connected) return res.json({ ok: false, error: 'Bot not connected' });
  if (!guardState.active) return res.json({ ok: false, error: 'Guard mode not active' });
  guardState.attackPlayers = true;
  console.log('[Guard] Attack nearby players: ON');
  res.json({ ok: true });
});

// POST /guard/attack-players/stop
app.post('/guard/attack-players/stop', (req, res) => {
  guardState.attackPlayers = false;
  try { if (bot) bot.pathfinder.setGoal(null); } catch(e) {}
  console.log('[Guard] Attack nearby players: OFF');
  res.json({ ok: true });
});

// Chat web panel
app.get('/chat', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>${config.name} - Chat</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #0f172a; color: #f8fafc;
            display: flex; flex-direction: column;
            height: 100vh; overflow: hidden;
          }
          header {
            background: #1e293b; padding: 14px 20px;
            display: flex; align-items: center; gap: 14px;
            border-bottom: 1px solid #334155;
            flex-shrink: 0;
          }
          header a {
            color: #94a3b8; text-decoration: none; font-size: 13px;
            background: #334155; padding: 6px 12px; border-radius: 6px;
          }
          header h1 { font-size: 18px; color: #2dd4bf; }
          #status-badge {
            margin-left: auto; font-size: 12px; padding: 4px 10px;
            border-radius: 99px; font-weight: bold;
          }
          #chat-box {
            flex: 1; overflow-y: auto; padding: 16px 20px;
            display: flex; flex-direction: column; gap: 6px;
          }
          .msg {
            padding: 8px 14px; border-radius: 10px;
            font-size: 14px; max-width: 80%; word-break: break-word;
            line-height: 1.5;
          }
          .msg.incoming {
            background: #1e293b; border-left: 3px solid #2dd4bf;
            align-self: flex-start;
          }
          .msg.outgoing {
            background: #164e63; border-left: 3px solid #06b6d4;
            align-self: flex-end; text-align: right;
          }
          .msg .who { font-size: 11px; color: #94a3b8; margin-bottom: 2px; }
          .msg .text { color: #e2e8f0; }
          footer {
            background: #1e293b; border-top: 1px solid #334155;
            padding: 14px 20px; display: flex; gap: 10px; flex-shrink: 0;
          }
          #msg-input {
            flex: 1; background: #0f172a; border: 1px solid #334155;
            color: #f8fafc; padding: 10px 14px; border-radius: 8px;
            font-size: 15px; outline: none;
          }
          #msg-input:focus { border-color: #2dd4bf; }
          #send-btn {
            background: #2dd4bf; color: #0f172a; border: none;
            padding: 10px 22px; border-radius: 8px; font-weight: bold;
            font-size: 15px; cursor: pointer; transition: opacity 0.2s;
          }
          #send-btn:hover { opacity: 0.85; }
          #send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
          .empty-hint {
            color: #475569; text-align: center; margin: auto;
            font-size: 14px;
          }
        </style>
      </head>
      <body>
        <header>
          <a href="/">← Dashboard</a>
          <h1>💬 MC Chat</h1>
          <span id="status-badge">...</span>
        </header>

        <div id="chat-box">
          <p class="empty-hint" id="empty-hint">Loading chat log...</p>
        </div>

        <footer>
          <input id="msg-input" type="text" placeholder="Type a message to send as bot..." maxlength="256" autofocus />
          <button id="send-btn" disabled>Send</button>
        </footer>

        <script>
          const input = document.getElementById('msg-input');
          const sendBtn = document.getElementById('send-btn');
          const chatBox = document.getElementById('chat-box');
          const statusBadge = document.getElementById('status-badge');
          const emptyHint = document.getElementById('empty-hint');
          let lastCount = 0;
          let connected = false;

          function formatTime(ts) {
            const d = new Date(ts);
            return d.toLocaleTimeString();
          }

          function escapeHtml(t) {
            return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          }

          async function fetchLog() {
            try {
              const [logRes, healthRes] = await Promise.all([
                fetch('/chat-log'), fetch('/health')
              ]);
              const { log } = await logRes.json();
              const health = await healthRes.json();

              connected = health.status === 'connected';
              statusBadge.textContent = connected ? '🟢 Online' : '🔴 Offline';
              statusBadge.style.background = connected ? '#14532d' : '#450a0a';
              statusBadge.style.color = connected ? '#4ade80' : '#f87171';
              sendBtn.disabled = !connected;

              if (log.length !== lastCount) {
                lastCount = log.length;
                const atBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 60;
                
                // Remove empty hint
                if (emptyHint) emptyHint.remove();

                chatBox.innerHTML = log.length === 0
                  ? '<p class="empty-hint">No messages yet. Chat will appear here.</p>'
                  : log.map(m => \`
                    <div class="msg \${m.fromConsole ? 'outgoing' : 'incoming'}">
                      <div class="who">\${escapeHtml(m.username)} · \${formatTime(m.time)}</div>
                      <div class="text">\${escapeHtml(m.message)}</div>
                    </div>
                  \`).join('');

                if (atBottom) chatBox.scrollTop = chatBox.scrollHeight;
              }
            } catch(e) {
              statusBadge.textContent = '⚪ Error';
              statusBadge.style.background = '#1e293b';
            }
          }

          async function sendMessage() {
            const msg = input.value.trim();
            if (!msg || !connected) return;
            sendBtn.disabled = true;
            input.value = '';
            try {
              const res = await fetch('/send-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: msg })
              });
              const data = await res.json();
              if (!data.ok) alert('Failed: ' + data.error);
              else { await fetchLog(); chatBox.scrollTop = chatBox.scrollHeight; }
            } catch(e) {
              alert('Request failed');
            }
            sendBtn.disabled = !connected;
            input.focus();
          }

          sendBtn.addEventListener('click', sendMessage);
          input.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

          fetchLog();
          setInterval(fetchLog, 1500);
        </script>
      </body>
    </html>
  `);
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] HTTP server started on port ${PORT}`);
});

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

// ============================================================
// SELF-PING - Prevent Render from sleeping
// ============================================================
const SELF_PING_INTERVAL = 10 * 60 * 1000; // 10 minutes

const https = require('https');

function startSelfPing() {
  setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const protocol = url.startsWith('https') ? https : http;

    protocol.get(`${url}/ping`, (res) => {
      // console.log(`[KeepAlive] Self-ping: ${res.statusCode}`); // Optional: reduce spam
    }).on('error', (err) => {
      console.log(`[KeepAlive] Self-ping failed: ${err.message}`);
    });
  }, SELF_PING_INTERVAL);
  console.log('[KeepAlive] Self-ping system started (every 10 min)');
}

startSelfPing();

// ============================================================
// MEMORY MONITORING
// ============================================================
setInterval(() => {
  const mem = process.memoryUsage();
  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
  console.log(`[Memory] Heap: ${heapMB} MB`);
}, 5 * 60 * 1000); // Every 5 minutes

// ============================================================
// HUNT MODE ENGINE
// ============================================================
function startHuntMode() {
  if (huntState.active) return;
  huntState.active = true;
  huntState.status = 'hunting';
  huntState.kills = 0;
  huntState.itemsCollected = 0;
  console.log('[Hunt] Hunt mode STARTED');

  // Main hunt loop — find and attack raid mobs
  huntState.huntInterval = setInterval(async () => {
    if (!bot || !botState.connected || !huntState.active) return;

    try {
      // Find nearest raid mob — check both name and displayName, case-insensitive
      const target = Object.values(bot.entities).find(e => {
        if (!e.position) return false;
        const dist = bot.entity.position.distanceTo(e.position);
        if (dist > 32) return false;
        const nameStr = (e.name || e.displayName || e.username || '').toLowerCase();
        return RAID_MOBS.some(m => nameStr.includes(m));
      });

      if (target) {
        huntState.currentTarget = target.name || target.displayName || 'mob';
        huntState.status = 'hunting';
        const dist = bot.entity.position.distanceTo(target.position);

        if (dist <= 3) {
          // In melee range — swing
          try { bot.attack(target); } catch(e) {}
        } else {
          // Move closer — GoalNear gets within 2 blocks
          try {
            bot.pathfinder.setGoal(new GoalNear(
              target.position.x,
              target.position.y,
              target.position.z,
              2
            ));
          } catch(e) {}
        }
      } else {
        huntState.currentTarget = null;
        collectNearbyItems();
      }
    } catch(e) {
      console.log('[Hunt] Loop error:', e.message);
    }
  }, 400);

  // Listen for mob deaths to count kills
  if (bot) {
    bot._huntDeathListener = (entity) => {
      if (!huntState.active) return;
      const nameStr = (entity.name || entity.displayName || '').toLowerCase();
      if (RAID_MOBS.some(m => nameStr.includes(m))) {
        huntState.kills++;
        console.log(`[Hunt] Killed ${nameStr} (total: ${huntState.kills})`);
        setTimeout(() => collectNearbyItems(), 1500);
      }
    };
    bot.on('entityDead', bot._huntDeathListener);
  }
}

function stopHuntMode() {
  huntState.active = false;
  huntState.status = 'idle';
  huntState.currentTarget = null;
  if (huntState.huntInterval) { clearInterval(huntState.huntInterval); huntState.huntInterval = null; }
  if (huntState.collectInterval) { clearInterval(huntState.collectInterval); huntState.collectInterval = null; }
  if (bot && bot._huntDeathListener) {
    bot.removeListener('entityDead', bot._huntDeathListener);
    bot._huntDeathListener = null;
  }
  // Stop pathfinder movement
  try { if (bot) bot.pathfinder.setGoal(null); } catch(e) {}
  console.log('[Hunt] Hunt mode STOPPED');
}

async function collectNearbyItems() {
  if (!bot || !botState.connected) return;
  try {
    // Find nearby item entities (dropped loot)
    const items = Object.values(bot.entities).filter(e =>
      e.type === 'object' && e.objectType === 'Item' &&
      e.position &&
      bot.entity.position.distanceTo(e.position) < 12
    );

    if (items.length === 0) return;

    huntState.status = 'collecting';
    const nearest = items.reduce((a, b) =>
      bot.entity.position.distanceTo(a.position) < bot.entity.position.distanceTo(b.position) ? a : b
    );

    const dist = bot.entity.position.distanceTo(nearest.position);
    if (dist < 1.5) {
      huntState.itemsCollected++;
    } else {
      try {
        bot.pathfinder.setGoal(new GoalBlock(
          Math.floor(nearest.position.x),
          Math.floor(nearest.position.y),
          Math.floor(nearest.position.z)
        ), true);
      } catch(e) {}
    }

    if (huntState.active) huntState.status = 'hunting';
  } catch(e) {
    console.log('[Hunt] Collect error:', e.message);
  }
}

async function dropAllAndReturn() {
  if (!bot || !botState.connected) return;
  console.log('[Hunt] Dropping all items and returning home...');
  huntState.status = 'returning';

  try {
    // Drop every item EXCEPT swords/axes
    const items = bot.inventory.items().filter(i =>
      !SWORD_NAMES.some(s => i.name.toLowerCase().includes(s))
    );
    for (const item of items) {
      try {
        await bot.toss(item.type, null, item.count);
        await new Promise(r => setTimeout(r, 200));
      } catch(e) {
        console.log('[Hunt] Drop error:', e.message);
      }
    }
    console.log(`[Hunt] Dropped ${items.length} item stacks (sword kept)`);
  } catch(e) {
    console.log('[Hunt] Error dropping items:', e.message);
  }

  // Go home if home is set
  if (homePosition) {
    try {
      bot.pathfinder.setGoal(new GoalBlock(homePosition.x, homePosition.y, homePosition.z));
      console.log(`[Hunt] Returning to home ${homePosition.x}, ${homePosition.y}, ${homePosition.z}`);

      // Watch for arrival
      const checkArrival = setInterval(() => {
        if (!bot || !botState.connected) { clearInterval(checkArrival); return; }
        const dist = bot.entity.position.distanceTo({ x: homePosition.x, y: homePosition.y, z: homePosition.z });
        if (dist < 2) {
          clearInterval(checkArrival);
          huntState.status = huntState.active ? 'hunting' : 'idle';
          try { bot.pathfinder.setGoal(null); } catch(e) {}
          console.log('[Hunt] Arrived home.');
        }
      }, 1000);
    } catch(e) {
      console.log('[Hunt] Pathfind home error:', e.message);
      huntState.status = huntState.active ? 'hunting' : 'idle';
    }
  } else {
    huntState.status = huntState.active ? 'hunting' : 'idle';
    console.log('[Hunt] No home set — stayed in place.');
  }
}

// ============================================================
// GUARD MODE ENGINE
// ============================================================
function startGuardMode(playerName) {
  stopGuardMode(); // clear any existing
  guardState.active = true;
  guardState.targetPlayer = playerName;
  console.log(`[Guard] Guarding player: ${playerName}`);

  guardState.guardInterval = setInterval(() => {
    if (!bot || !botState.connected || !guardState.active) return;

    try {
      // Find the guarded player entity
      const guardedPlayer = Object.values(bot.entities).find(e =>
        e.type === 'player' && e.username === guardState.targetPlayer && e.position
      );

      if (!guardedPlayer) return; // player not visible, stay put

      const distToPlayer = bot.entity.position.distanceTo(guardedPlayer.position);

      // Find any hostile mob attacking or near the guarded player (within 16 blocks of them)
      const threat = Object.values(bot.entities).find(e => {
        if (!e.position) return false;
        const nameStr = (e.name || e.displayName || '').toLowerCase();
        if (!HOSTILE_MOBS.some(m => nameStr.includes(m))) return false;
        const distToGuarded = e.position.distanceTo(guardedPlayer.position);
        return distToGuarded < 16;
      });

      if (threat) {
        // Attack the threat
        const distToThreat = bot.entity.position.distanceTo(threat.position);
        if (distToThreat <= 3) {
          try { bot.attack(threat); } catch(e) {}
        } else {
          try {
            bot.pathfinder.setGoal(new GoalNear(
              threat.position.x, threat.position.y, threat.position.z, 2
            ));
          } catch(e) {}
        }
      } else if (guardState.attackPlayers) {
        // Attack nearby players (excluding the guarded one and the bot itself)
        const enemyPlayer = Object.values(bot.entities).find(e =>
          e.type === 'player' &&
          e.username !== bot.username &&
          e.username !== guardState.targetPlayer &&
          e.position &&
          bot.entity.position.distanceTo(e.position) < 16
        );
        if (enemyPlayer) {
          const d = bot.entity.position.distanceTo(enemyPlayer.position);
          if (d <= 3) {
            try { bot.attack(enemyPlayer); } catch(e) {}
          } else {
            try {
              bot.pathfinder.setGoal(new GoalNear(
                enemyPlayer.position.x, enemyPlayer.position.y, enemyPlayer.position.z, 2
              ));
            } catch(e) {}
          }
        } else if (distToPlayer > 4) {
          try {
            bot.pathfinder.setGoal(new GoalNear(
              guardedPlayer.position.x, guardedPlayer.position.y, guardedPlayer.position.z, 3
            ));
          } catch(e) {}
        } else {
          try { bot.pathfinder.setGoal(null); } catch(e) {}
        }
      } else if (distToPlayer > 4) {
        // No threat — stay close to guarded player
        try {
          bot.pathfinder.setGoal(new GoalNear(
            guardedPlayer.position.x,
            guardedPlayer.position.y,
            guardedPlayer.position.z,
            3
          ));
        } catch(e) {}
      } else {
        // Close enough, stop moving
        try { bot.pathfinder.setGoal(null); } catch(e) {}
      }
    } catch(e) {
      console.log('[Guard] Error:', e.message);
    }
  }, 500);
}

function stopGuardMode() {
  guardState.active = false;
  guardState.targetPlayer = null;
  guardState.attackPlayers = false;
  if (guardState.guardInterval) {
    clearInterval(guardState.guardInterval);
    guardState.guardInterval = null;
  }
  try { if (bot) bot.pathfinder.setGoal(null); } catch(e) {}
  console.log('[Guard] Guard mode stopped');
}

// Auto-equip sword on spawn helper
async function equipSwordIfAvailable() {
  if (!bot) return;
  try {
    const sword = bot.inventory.items().find(i =>
      SWORD_NAMES.some(s => i.name.toLowerCase().includes(s))
    );
    if (sword) {
      await bot.equip(sword, 'hand');
      console.log(`[Sword] Auto-equipped ${sword.name}`);
    }
  } catch(e) {}
}

// ============================================================
// BOT CREATION WITH RECONNECTION LOGIC
// ============================================================
let bot = null;
let activeIntervals = [];
let reconnectTimeout = null;
let isReconnecting = false;

function clearAllIntervals() {
  console.log(`[Cleanup] Clearing ${activeIntervals.length} intervals`);
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals = [];
}

function addInterval(callback, delay) {
  const id = setInterval(callback, delay);
  activeIntervals.push(id);
  return id;
}

function getReconnectDelay() {
  // Aggressive reconnection: fast, flat delay or very subtle backoff
  const baseDelay = config.utils['auto-reconnect-delay'] || 2000;
  const maxDelay = config.utils['max-reconnect-delay'] || 15000;

  // Use a much gentler backoff or just a flat delay if user wants "lower"
  // Current logic: attempts * 1000 + base, capped at max
  const delay = Math.min(baseDelay + (botState.reconnectAttempts * 1000), maxDelay);

  return delay;
}

function createBot() {
  if (isReconnecting) {
    console.log('[Bot] Already reconnecting, skipping...');
    return;
  }

  // Cleanup previous bot
  if (bot) {
    clearAllIntervals();
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (e) {
      console.log('[Cleanup] Error ending previous bot:', e.message);
    }
    bot = null;
  }

  console.log(`[Bot] Creating bot instance...`);
  console.log(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);

  try {
    bot = mineflayer.createBot({
      username: config['bot-account'].username,
      password: config['bot-account'].password || undefined,
      auth: config['bot-account'].type,
      host: config.server.ip,
      port: config.server.port,
      version: config.server.version,
      hideErrors: false,
      checkTimeoutInterval: 120000 // 2 minutes - detects dead connections without false-positive disconnects
    });

    bot.loadPlugin(pathfinder);

    // Connection timeout - if no spawn in 60s, reconnect
    const connectionTimeout = setTimeout(() => {
      if (!botState.connected) {
        console.log('[Bot] Connection timeout - no spawn received');
        scheduleReconnect();
      }
    }, 60000);

    bot.once('spawn', () => {
      clearTimeout(connectionTimeout);
      botState.connected = true;
      botState.lastActivity = Date.now();
      botState.reconnectAttempts = 0;
      isReconnecting = false;

      console.log(`[Bot] [+] Successfully spawned on server!`);
      if (config.discord && config.discord.events.connect) {
        sendDiscordWebhook(`[+] **Connected** to \`${config.server.ip}\``, 0x4ade80); // Green
      }

      const mcData = require('minecraft-data')(config.server.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowFreeMotion = false;
      defaultMove.canDig = false;
      defaultMove.liquidCost = 1000;
      defaultMove.fallDamageCost = 1000;

      // Start all modules
      initializeModules(bot, mcData, defaultMove);

      // Auto-equip sword if available
      setTimeout(() => equipSwordIfAvailable(), 2000);

      // Setup enhanced Leave/Rejoin logic
      setupLeaveRejoin(bot, createBot);

      setTimeout(() => {
        if (bot && botState.connected) {
          bot.chat('/gamerule sendCommandFeedback false');
        }
      }, 3000);

      // Attempt creative mode (only works if bot has OP)
      setTimeout(() => {
        if (bot && botState.connected) {
          bot.chat('/gamemode creative');
          console.log('[INFO] Attempted to set creative mode (requires OP)');
        }
      }, 3000);

      bot.on('messagestr', (message) => {
        if (
          message.includes('commands.gamemode.success.self') ||
          message.includes('Set own game mode to Creative Mode')
        ) {
          console.log('[INFO] Bot is now in Creative Mode.');
          bot.chat('/gamerule sendCommandFeedback false');
        }
      });

      // Log all chat messages to the web panel + trigger AI if mentioned
      bot.on('chat', (username, message) => {
        addChatLog(username, message, false);
        if (config.utils['chat-log']) {
          console.log(`[MC Chat] <${username}> ${message}`);
        }
        // AI auto-reply when bot is mentioned
        if (shouldAiRespond(username, message)) {
          handleAiChat(username, message);
        }
      });
    });

    

    // Handle disconnection
    bot.on('end', (reason) => {
      console.log(`[Bot] Disconnected: ${reason || 'Unknown reason'}`);
      botState.connected = false;
      clearAllIntervals();
      stopGuardMode();

      if (config.discord && config.discord.events.disconnect && reason !== 'Periodic Rejoin') {
        sendDiscordWebhook(`[-] **Disconnected**: ${reason || 'Unknown'}`, 0xf87171); // Red
      }

      if (config.utils['auto-reconnect']) {
        scheduleReconnect();
      }
    });

    bot.on('kicked', (reason) => {
      const wasSpawned = botState.connected;
      console.log(`[Bot] Kicked: ${reason}`);
      botState.connected = false;
      botState.errors.push({ type: 'kicked', reason, time: Date.now() });
      clearAllIntervals();

      if (config.discord && config.discord.events.disconnect) {
        sendDiscordWebhook(`[!] **Kicked**: ${reason}`, 0xff0000); // Bright Red
      }

      if (config.utils['auto-reconnect']) {
        scheduleReconnect();
      }
    });

    bot.on('error', (err) => {
      console.log(`[Bot] Error: ${err.message}`);
      botState.errors.push({ type: 'error', message: err.message, time: Date.now() });
      // Don't immediately reconnect on error - let 'end' event handle it
    });

  } catch (err) {
    console.log(`[Bot] Failed to create bot: ${err.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }

  if (isReconnecting) {
    return;
  }

  isReconnecting = true;
  botState.reconnectAttempts++;

  const delay = getReconnectDelay();
  console.log(`[Bot] Reconnecting in ${delay / 1000}s (attempt #${botState.reconnectAttempts})`);

  reconnectTimeout = setTimeout(() => {
    isReconnecting = false;
    createBot();
  }, delay);
}

// ============================================================
// MODULE INITIALIZATION
// ============================================================
function initializeModules(bot, mcData, defaultMove) {
  console.log('[Modules] Initializing all modules...');

  // ---------- AUTO AUTH ----------
  if (config.utils['auto-auth'].enabled) {
    const password = config.utils['auto-auth'].password;
    setTimeout(() => {
      bot.chat(`/register ${password} ${password}`);
      bot.chat(`/login ${password}`);
      console.log('[Auth] Sent login commands');
    }, 1000);
  }

  // ---------- CHAT MESSAGES ----------
  if (config.utils['chat-messages'].enabled) {
    const messages = config.utils['chat-messages'].messages;
    if (config.utils['chat-messages'].repeat) {
      let i = 0;
      addInterval(() => {
        if (bot && botState.connected) {
          bot.chat(messages[i]);
          botState.lastActivity = Date.now();
          i = (i + 1) % messages.length;
        }
      }, config.utils['chat-messages']['repeat-delay'] * 1000);
    } else {
      messages.forEach((msg, idx) => {
        setTimeout(() => bot.chat(msg), idx * 1000);
      });
    }
  }

  // ---------- MOVE TO POSITION (disabled — use Set Home + Drop & Return instead) ----------
  // if (config.position.enabled) {
  //   bot.pathfinder.setMovements(defaultMove);
  //   bot.pathfinder.setGoal(new GoalBlock(config.position.x, config.position.y, config.position.z));
  // }

  // ---------- ANTI-AFK (disabled sneak to prevent drift) ----------

  // ---------- PERIODIC FACE TURN (every 30s, rotate 30 degrees) ----------
  let currentYaw = 0;
  addInterval(() => {
    if (!bot || !botState.connected || huntState.active) return;
    try {
      currentYaw += (30 * Math.PI) / 180; // +30 degrees in radians
      bot.look(currentYaw, 0, true);
      botState.lastActivity = Date.now();
    } catch (e) {
      console.log('[FaceTurn] Error:', e.message);
    }
  }, 30000);

  // ---------- CUSTOM MODULES ----------
  // avoidMobs disabled — causes backwards walking conflicts
  // if (config.modules.avoidMobs) avoidMobs(bot);
  if (config.modules.combat) combatModule(bot, mcData);
  if (config.modules.beds) bedModule(bot, mcData);
  if (config.modules.chat) chatModule(bot);

  // Periodic Rejoin
  if (config.utils['periodic-rejoin'] && config.utils['periodic-rejoin'].enabled) {
    periodicRejoin(bot);
  }

  console.log('[Modules] All modules initialized!');
}

// Periodic Rejoin Module
const setupLeaveRejoin = require('./leaveRejoin');

// Periodic Rejoin Module - Handled by leaveRejoin.js now
function periodicRejoin(bot) {
  // Deprecated in favor of leaveRejoin.js
  console.log('[Rejoin] Using new leaveRejoin system.');
}

// ============================================================
// CUSTOM MODULES
// ============================================================

// Avoid mobs/players — skips raid mobs (handled by hunt) and pauses during hunt mode
function avoidMobs(bot) {
  const safeDistance = 5;
  addInterval(() => {
    if (!bot || !botState.connected) return;
    if (huntState.active) return; // hunt mode handles its own movement
    try {
      const entities = Object.values(bot.entities).filter(e =>
        (e.type === 'mob' || (e.type === 'player' && e.username !== bot.username)) &&
        // don't flee from raid mobs — hunt mode will attack them instead
        !(e.name && RAID_MOBS.some(m => e.name.toLowerCase().includes(m)))
      );
      for (const e of entities) {
        if (!e.position) continue;
        const distance = bot.entity.position.distanceTo(e.position);
        if (distance < safeDistance) {
          bot.setControlState('back', true);
          setTimeout(() => {
            if (bot) bot.setControlState('back', false);
          }, 500);
          break;
        }
      }
    } catch (e) {
      console.log('[AvoidMobs] Error:', e.message);
    }
  }, 2000);
}

// Combat module
function combatModule(bot, mcData) {
  addInterval(() => {
    if (!bot || !botState.connected) return;
    if (huntState.active) return; // hunt mode handles combat during hunt
    try {
      if (config.combat['attack-mobs']) {
        const mobs = Object.values(bot.entities).filter(e =>
          e.type === 'mob' && e.position &&
          bot.entity.position.distanceTo(e.position) < 4
        );
        if (mobs.length > 0) {
          bot.attack(mobs[0]);
        }
      }
    } catch (e) {
      console.log('[Combat] Error:', e.message);
    }
  }, 1500);

  bot.on('health', () => {
    if (!config.combat['auto-eat']) return;
    try {
      if (bot.food < 14) {
        const food = bot.inventory.items().find(i => {
          const itemData = mcData.itemsByName[i.name];
          return itemData && itemData.food;
        });
        if (food) {
          bot.equip(food, 'hand')
            .then(() => bot.consume())
            .catch(e => console.log('[AutoEat] Error:', e.message));
        }
      }
    } catch (e) {
      console.log('[AutoEat] Error:', e.message);
    }
  });
}

// Bed module (FIXED - beds are blocks, not entities)
function bedModule(bot, mcData) {
  addInterval(async () => {
    if (!bot || !botState.connected) return;

    try {
      const isNight = bot.time.timeOfDay >= 12500 && bot.time.timeOfDay <= 23500;

      if (config.beds['place-night'] && isNight && !bot.isSleeping) {
        // Find nearby bed blocks
        const bedBlock = bot.findBlock({
          matching: block => block.name.includes('bed'),
          maxDistance: 8
        });

        if (bedBlock) {
          try {
            await bot.sleep(bedBlock);
            console.log('[Bed] Sleeping...');
          } catch (e) {
            // Can't sleep - maybe not night enough or monsters nearby
          }
        }
      }
    } catch (e) {
      console.log('[Bed] Error:', e.message);
    }
  }, 10000);
}

// Chat module
function chatModule(bot) {
  bot.on('chat', (username, message) => {
    if (!bot || username === bot.username) return;

    try {
      if (config.chat.respond) {
        const lowerMsg = message.toLowerCase();
        if (lowerMsg.includes('hello') || lowerMsg.includes('hi')) {
          bot.chat(`Hello, ${username}!`);
        }
        if (message.startsWith('!tp ') && config.chat.respond) {
          const target = message.split(' ')[1];
          if (target) bot.chat(`/tp ${target}`);
        }
      }
    } catch (e) {
      console.log('[Chat] Error:', e.message);
    }
  });
}

// ============================================================
// CONSOLE COMMANDS
// ============================================================
const readline = require('readline');
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  if (!bot || !botState.connected) {
    console.log('[Console] Bot not connected');
    return;
  }

  const trimmed = line.trim();
  if (trimmed.startsWith('say ')) {
    const msg = trimmed.slice(4);
    bot.chat(msg);
    addChatLog(config['bot-account'].username + ' [YOU]', msg, true);
  } else if (trimmed.startsWith('cmd ')) {
    bot.chat('/' + trimmed.slice(4));
  } else if (trimmed === 'status') {
    console.log(`Connected: ${botState.connected}, Uptime: ${formatUptime(Math.floor((Date.now() - botState.startTime) / 1000))}`);
  } else if (trimmed === 'reconnect') {
    console.log('[Console] Manual reconnect requested');
    bot.end();
  } else {
    bot.chat(trimmed);
  }
});

// ============================================================
// DISCORD WEBHOOK INTEGRATION
// ============================================================
function sendDiscordWebhook(content, color = 0x0099ff) {
  if (!config.discord || !config.discord.enabled || !config.discord.webhookUrl || config.discord.webhookUrl.includes('YOUR_DISCORD')) return;

  const protocol = config.discord.webhookUrl.startsWith('https') ? https : http;
  const urlParts = new URL(config.discord.webhookUrl);

  const payload = JSON.stringify({
    username: config.name,
    embeds: [{
      description: content,
      color: color,
      timestamp: new Date().toISOString(),
      footer: { text: 'Slobos AFK Bot' }
    }]
  });

  const options = {
    hostname: urlParts.hostname,
    port: 443,
    path: urlParts.pathname + urlParts.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': payload.length
    }
  };

  const req = protocol.request(options, (res) => {
    // console.log(`[Discord] Sent webhook: ${res.statusCode}`);
  });

  req.on('error', (e) => {
    console.log(`[Discord] Error sending webhook: ${e.message}`);
  });

  req.write(payload);
  req.end();
}

// ============================================================
// CRASH RECOVERY - IMMORTAL MODE
// ============================================================
process.on('uncaughtException', (err) => {
  console.log(`[FATAL] Uncaught Exception: ${err.message}`);
  // console.log(err.stack); // Optional: keep logs cleaner
  botState.errors.push({ type: 'uncaught', message: err.message, time: Date.now() });

  // CRITICAL: DO NOT EXIT.
  // The user wants the server to stay up "all the time no matter what".
  // We just clear intervals and try to restart the bot logic.
  if (config.utils['auto-reconnect']) {
    clearAllIntervals();
    // Wrap in a tiny timeout to prevent tight loops if the error is synchronous
    setTimeout(() => {
      scheduleReconnect();
    }, 1000);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.log(`[FATAL] Unhandled Rejection: ${reason}`);
  botState.errors.push({ type: 'rejection', message: String(reason), time: Date.now() });
  // Do not exit.
});

// Graceful shutdown from external signals (still allowed to exit if system demands it)
process.on('SIGTERM', () => {
  console.log('[System] SIGTERM received. Ignoring to stay alive? (Render might force kill)');
  // If we mistakenly exit here, the web server dies. 
  // User asked for "all the time on no matter what".
  // Note: Render will SIGKILL if we don't exit, but this keeps us up as long as possible.
  process.exit(0);
});

process.on('SIGINT', () => {
  // Local Ctrl+C
  console.log('[System] Manual stop requested. Exiting...');
  process.exit(0);
});

// ============================================================
// START THE BOT
// ============================================================
console.log('='.repeat(50));
console.log('  Minecraft AFK Bot v2.3 - Bug Fix Edition');
console.log('='.repeat(50));
console.log(`Server: ${config.server.ip}:${config.server.port}`);
console.log(`Version: ${config.server.version}`);
console.log(`Auto-Reconnect: ${config.utils['auto-reconnect'] ? 'Enabled' : 'Disabled'}`);
console.log('='.repeat(50));

createBot();
