# Lottie Characters

Drop After Effects (Bodymovin) JSON files in this directory and reference them in `narration.json` per scene:

```json
{
  "id": "hook",
  "actor": { "lottie": "stickman-wave.json" }
}
```

Or omit `lottie` to use the procedural stickman cast:

```json
{
  "id": "hook",
  "actor": { "action": "wave", "mood": "happy", "cast": 2 }
}
```

Actions: `idle`, `walk`, `run`, `jump`, `wave`, `think`, `cheer`, `sit`, `fall`, `point`, `shrug`, `dance`.
Moods: `happy`, `neutral`, `sad`.
