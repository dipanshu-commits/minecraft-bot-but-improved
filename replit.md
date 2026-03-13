# Minecraft AFK Bot

## Overview
A Minecraft AFK bot built with Node.js using the mineflayer library. It connects to a Minecraft server and performs AFK actions (jumping, walking, looking around) to keep the player active. Includes a web dashboard on port 5000 showing bot status, uptime, and coordinates.

## Project Architecture
- `index.js` - Main entry point: Express web server (port 5000) + Mineflayer bot logic
- `leaveRejoin.js` - Leave/rejoin cycle module for periodic reconnection
- `settings.json` - Bot configuration (server IP, port, version, bot username, modules)
- `launcher_accounts.json` - Minecraft launcher accounts data

## Key Dependencies
- **express** - Web server for status dashboard
- **mineflayer** - Minecraft bot framework
- **mineflayer-pathfinder** - Pathfinding plugin
- **minecraft-data** - Minecraft data library

## Configuration
Bot settings are in `settings.json`:
- Server connection (IP, port, version)
- Bot account (username, auth type)
- Movement modules (circle-walk, random-jump, look-around)
- Utility modules (anti-afk, auto-auth, chat messages, auto-reconnect)
- Discord webhook notifications (optional)

## Running
- Node.js 22+ required (mineflayer dependency)
- `npm start` or `node index.js`
- Web dashboard available at port 5000
- Deployment target: VM (needs persistent connection to Minecraft server)
