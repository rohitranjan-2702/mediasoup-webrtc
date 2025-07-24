# Setup

- Prequesites: have nodejs, ffmpeg installed

## Backend setup

```bash
cd server
pnpm i
pnpm dev
```

## Frontend Setup

```bash
cd fermion-app
pnpm i
pnpm dev
```

Visit http://localhost:3000/stream for connecting to video call & http://localhost:3000/watch to watch them chat


# Troubleshoot on MacOS
```bash
cd node_modules/.pnpm/mediasoup@3.16.7/node_modules/mediasoup
npm run worker:build
```
