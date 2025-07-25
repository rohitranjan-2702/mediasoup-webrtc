<img width="1269" height="651" alt="image" src="https://github.com/user-attachments/assets/0452eb4e-ce63-43f7-b685-2ba1467ebfca" />

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
