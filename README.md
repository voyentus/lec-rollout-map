# LEC Rollout Coverage

A signed-in web map for planning the LEC meter rollout: household and transformer
locations, mobile coverage, and shared gateway planning layers.

This repository holds only the app's code. All data lives in a Supabase database
and is loaded after sign-in; accounts are created by the project owner.

- `index.html`, `styles.css`, `app.js`: the app (no build step)
- `config.js`: the Supabase project address and its publishable key
