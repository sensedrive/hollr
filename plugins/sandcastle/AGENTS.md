# Sandcastle plugin

- Design source of truth: magicfink project `sandcastle-board` (https://magicfink.finksmart.de/p/sandcastle-board).
  Every visible UI change goes there first (design request, `mode: "change"`), then into `ui/` to match the rendered frames.
  Logic without a visual effect may be built in parallel.
- Data contracts: server gate `sandcastle` (`server/src/sandcastle.ts`) for per-machine runs/queues/logs; this plugin's server does GitHub only.
